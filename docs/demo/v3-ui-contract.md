# demo v3:后端 ↔ 前端契约(2026-09-04 凌晨)

本轮 Jacky 反馈六点:①AI 分析要更"量化"(突发行情/美股开盘/日线级别牛熊);②工作流保存不了、每分钟扫 10 次太频;③SOL 做过两笔但结束后看不到,要复盘页;④所有币安资产都能交易;⑤日志不醒目、状态要突出;⑥对话没文字产出、交互目的不明。
后端改动全在 `packages/gateway/src/demo/`,前端全在 `packages/webui/`。**前端只按本文的接口形状写**,不猜后端内部。旧接口不在此文者形状不变。

## 0. 设计原则(给前端写文案用)

- **代码出触发器,模型做判断。** 以前是每根 K 线收盘对 watchlist 每个币各调一次模型(1m × 6 币 = 每分钟 6 次)。v3 默认 `scan_mode = 'triggered'`:每根收盘只本地算特征,只有触发器命中(突破 20 根高低点 / EMA 交叉 / 放量 / 5 分钟急拉急跌 / 美股开收盘窗口 / 资金费率极端 / 回踩 EMA20)或到心跳(默认 30 分钟一次)才叫模型。急拉急跌由 10 秒一次的行情轮询直接唤醒,不等收盘。
- **日线状态由代码算**(EMA20/50/200 排列、20 日涨跌、波动率分位)作为证据给模型,不靠模型猜牛熊。
- **模型每次调用 ≈ ¥0.006(GLM)**;工作流面板要给出"预计每小时调用次数"。

## 1. Workflow(GET/POST /api/workflow)

POST 语义变化:**能应用的字段就应用,不合法的字段在 `errors` 里逐条报**(以前是任一字段错就整体不保存)。返回始终 200 `{ workflow, errors: string[] }`,`errors` 每条以字段名开头,如 `leverage 必须是数字`。前端应只发**改动过的字段**(diff),并把 errors 按字段名前缀贴到对应输入框下。

新增字段(都在 Workflow 里,GET 也返回):

| 字段 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `scan_mode` | `'triggered' \| 'every_close'` | `triggered` | — | 触发器模式 / 每根收盘都问模型(演示用) |
| `heartbeat_every_ms` | number | 1800000 | 5 分钟–4 小时 | 触发器模式下,每个币最久多久问一次模型 |
| `fast_move_pct` | string(十进制) | `"0.8"` | 0.2–5 | 5 分钟内涨跌超过此百分比立刻唤醒 |
| `review_every_close` | boolean | false | — | 有持仓/挂单的线程是否每根收盘都复查(false = 只在成交/止损止盈/触发器/信息员变向/心跳时复查) |
| `narrate` | boolean | true | — | agent 旁白开关(原有字段,前端以前没暴露) |

预计调用次数/小时(前端展示用,近似):`every_close` = watchlist × (60 / tf 分钟);`triggered` ≈ watchlist × (60 / 心跳分钟) + 触发器(经验 0–4 次/币/小时)。

## 2. 交易历史与复盘(新)

`GET /api/history?limit=200` →

```jsonc
{
  "stats": {
    "count": 7, "wins": 3, "losses": 4, "flat": 0, "win_rate": 0.43,
    "total_pnl": "-12.30", "avg_pnl": "-1.76", "avg_hold_ms": 5400000,
    "profit_factor": 0.8,          // 总盈利/总亏损,无亏损时 null
    "best": { "thread_id": "thr-…", "symbol": "SOLUSDT", "pnl": "31.2" } | null,
    "worst": { … } | null,
    "by_symbol": [{ "symbol": "SOLUSDT", "count": 2, "wins": 1, "pnl": "-12.5" }],
    "by_source": [{ "source": "agent|manual|chat", "count": 5, "pnl": "…" }],
    "by_close_reason": [{ "reason": "止损触发", "count": 2, "pnl": "…" }]
  },
  "threads": [ /* StrategyThread 加上: */ { "hold_ms": 1234, "pnl_num": -43.75, "exit_price": "104.1" | null, "episode_count": 9, "r_multiple": -0.9 | null } ],
  "equity": [{ "at": 1788400000000, "equity": 10012.3, "unrealized": -3.1 }]   // 每 ≥60 秒一个点 + 每次平仓一个点,最多 2000 点
}
```

`threads` 只含 `closed | canceled | invalidated`,按 `closed_at` 倒序。`r_multiple` = 已实现盈亏 / (入场价与止损价距离 × 数量),没止损为 null。

单笔细节仍用 `GET /api/threads/:id` → `{ thread, episodes, intents }`(episodes 是 EpisodeSummary,含 action/headline/trigger/at)。

K 线取历史窗口:`GET /api/market/klines?symbol=SOLUSDT&tf=15m&limit=300&end_time=<ms>` 新增 `end_time`(不传 = 到现在)。前端画某笔交易时:tf 取线程 timeframe,end_time = closed_at + 若干根,叠加 entry / stop / tp / exit 的价格线与开平仓标记。

## 3. 活动流(新;给"日志"页顶部的醒目时间线)

`GET /api/activity?limit=200&before=<ms>` → `{ activity: ActivityItem[] }`(倒序);SSE 新事件 `activity`,data = ActivityItem。

```ts
interface ActivityItem {
  id: string; at: number;
  kind: ActivityKind;
  level: 'info' | 'success' | 'warn' | 'danger';
  symbol: string | null; thread_id: string | null; episode_id: string | null;
  title: string;            // ≤ 30 字,给徽章旁边那行,如 "SOLUSDT 做多 已成交 @ 104.99"
  detail: string | null;    // 一两句,可折叠
  data: Record<string, unknown>;  // 结构化数字(pnl、price、qty…),前端按需取
}
type ActivityKind =
  | 'proposal' | 'proposal_blocked' | 'approval_needed' | 'approved' | 'rejected'
  | 'thread_opened' | 'entry_filled' | 'protection_placed'
  | 'tp_hit' | 'sl_hit' | 'thread_closed' | 'thread_canceled' | 'thread_invalidated'
  | 'attention' | 'attention_cleared'
  | 'manual_order' | 'chat_action'
  | 'trigger' | 'info_update' | 'brain_error'
  | 'halt' | 'resume' | 'paused' | 'resumed' | 'workflow_changed';
```

建议分组与配色(前端定稿):交易(thread_opened/entry_filled/tp_hit/sl_hit/thread_closed/…)最醒目;agent(proposal/proposal_blocked/trigger/info_update/chat_action)次之;系统(halt/resume/paused/workflow_changed/brain_error)灰。`level` 已给出强弱,不要再自己判断。原始日志 `GET /api/logs` 与 SSE `log` 不变,放到次要位置。

## 4. 对话

- `ChatMessage` 新增 `kind: 'chat' | 'narration'`;`GET /api/chat/messages?limit=200&kind=chat|narration|all`(默认 all,旧行为)。旧数据没有 kind 的按 `旁白 · ` 前缀判定,后端已统一处理,前端只看 `kind`。
- 用户消息入队后**优先于扫描/复查执行**(队列插队),但如果正有一条判断在跑,仍要等它跑完(≤ 20 秒)。`GET /api/overview` 的 `queue` 会显示 `running.kind === 'chat'`。
- 对话能做什么(写进面板顶部的说明,不要让用户猜):问"为什么"(它会读判断记录)、让它看某个币 / 跑信息员 / 复查某线程、让它**提议**一笔单(数量由代码算,自动执行关着时要在界面点批准)、改观察列表 / 周期 / 信息员频率 / playbook / 暂停。风险、杠杆、上限、自动执行只能在工作流面板改。
- "问 agent 为什么":判断记录行和线程行加按钮,跳到 Agent 页并预填 `为什么 {symbol} 在 {HH:mm} 判断 {action}?(episode {id})`。后端 `get_thread` 与新工具 `get_episode{"id"}` 会把那条记录读给模型。

## 5. 全币种

- `GET /api/symbols` 现在返回**全部** USDT 永续(`status === 'TRADING'`,几百个),形状不变。纸面模式也从公开 exchangeInfo 拉。前端下单面板改成可搜索的下拉(cmdk),置顶 watchlist 与有线程的币;图表跟随所选币;`GET /api/market/klines` 支持任意币。
- 手动下单在任何币上都走同一条链路(风险、止损必填、杠杆 ≤ 10、名义上限),不需要在 watchlist 里。
- watchlist 上限仍是 8(那是 agent 扫描的范围,不是可交易范围)。

## 6. 行情状态(新,小)

`GET /api/market/regime?symbol=BTCUSDT` →

```jsonc
{ "symbol": "BTCUSDT", "as_of": 1788…,
  "daily": { "regime": "bull|bear|range|volatile", "ema_stack": "20>50>200", "ret_20d_pct": 8.3, "vol_pct_rank": 0.62, "atr_pct": 2.1, "text": "日线多头排列,20 日 +8.3%,波动率处于近 100 日 62% 分位" },
  "session": { "name": "us_open_window|us|london|asia|weekend|off", "text": "美股开盘窗口(±30 分钟),历史上波动放大", "minutes_to_us_open": 12 | null } }
```

交易页图表标题旁放一个小徽章显示 daily.regime 与 session.text(hover 显示 text)。

## 7. 判断记录

`Episode.trigger.kind` 新增值:`'fast_move' | 'breakout' | 'ema_cross' | 'vol_spike' | 'retest' | 'session' | 'funding' | 'heartbeat'`(原有的保留)。`Episode` 新增可选 `graph?: { node: string; edge: string | null; guards: string[] }`,前端有则显示,无则忽略。

## 8. 前端交付清单(fork 负责,只动 packages/webui)

1. 工作流面板:diff 保存、脏状态不被 SSE 覆盖、字段级错误、新字段、旁白开关、两个预设按钮(「演示节奏」= 1m/every_close/信息员 3 分钟;「稳健」= 15m/triggered/心跳 30 分钟/信息员 30 分钟)、预计调用次数/小时。
2. 对话面板:自动滚到底(Radix ScrollArea 的 viewport)、「对话 / 动态」两个 tab、顶部能力说明 + 快捷提问、发送后乐观显示、等待中显示已等秒数与队列状态、"问 agent 为什么"入口(判断记录页、线程行、复盘页)。
3. 新页面「复盘」(`#/history`,侧栏加入口):统计卡(数字滚动动效)、权益曲线(lightweight-charts 面积图)、按币/按来源/按平仓原因的小条形图、交易表(可按结果/币/来源筛选,点击展开:K 线 + 入场/止损/止盈/出场线与标记 + 该线程的判断时间线 + "问 agent 这笔为什么")。动效用 tw-animate-css / CSS transition,不新增依赖。
4. 日志页:上半是活动流(醒目徽章,按小时分组,交易/agent/系统三组筛选,关键词搜索),下半是原始日志(可折叠)。SSE `activity` 实时 prepend。
5. 交易页:全币种可搜索下拉;图表标题旁 regime/session 徽章;线程列表底部"已结束 N 条 → 复盘"。
6. `src/api/types.ts` / `client.ts` 补齐上述接口;mock/server.mjs 至少补 `/api/history`、`/api/activity`、`/api/market/regime`、`/api/chat/messages?kind=`,让 `npm run dev` 无后端也能看页面。
7. `npm run build --workspace packages/webui` 必须绿。

## 9. v3.1 增补(2026-09-04 上午):大脑切换 / 判断图 / 信息员独立页 / 纸面落库

### 9.1 大脑与模型(`GET /api/brains`、`POST /api/brains/test`、workflow 新字段)
- `Workflow.brain` / `cheap_brain` 的取值扩成 `pi | claude | codex | stub`;新增 `brain_model` / `cheap_brain_model: string | null`(空串视为 null = 该 CLI 的默认/环境变量)。模型 id 只接受 `[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}`;pi 写成 `provider/model`(如 `zai/glm-5.3`、`deepseek/deepseek-v4-flash`),claude 写 `sonnet|opus|haiku` 或完整 id,codex 写模型 id 或留空。
- 运行时按 `kind:model` 懒建并缓存 Brain 实例,改字段即时生效(下一次判断/信息员就用新的);对话工具 `set_workflow` 也允许改这四个字段。
- `GET /api/brains` → `{ brains: BrainOption[], current: { brain, cheap_brain } }`;`BrainOption = { kind, label, available(CLI 在 PATH 上), models(推荐,pi 来自 `pi --list-models`), default_model, note }`;`?refresh=1` 重新探测。
- `POST /api/brains/test {kind, model}` → `BrainTestResult { ok, kind, model, name, latency_ms, text, error }`,一次最短往返(5–60 秒)。
- `LoopView` 新增 `cheap_brain`(信息员大脑名)。
- codex 后端:`codex exec --skip-git-repo-check --ephemeral -s read-only -o <tmp>`,prompt 走 stdin(system 与 user 拼接),不留 session。

**CLI 启动命令(`Workflow.cli_commands`)**——没有两台机器一样,所以启动命令是用户可改的设置,不是硬编码的二进制名:

- `Workflow.cli_commands = { claude, codex, pi }`,默认分别是裸命令名 `claude` / `codex` / `pi`;启动时可用环境变量 `TG_DEMO_CLI_CLAUDE` / `TG_DEMO_CLI_CODEX` / `TG_DEMO_CLI_PI` 改默认值(只是默认值,库里存过的值优先)。
- 校验:字符串、去空格后非空、≤ 500 字符、不能有换行;`POST /api/workflow` 收**部分对象**(只给 `{"claude":"claudeproxy"}` 也行,其余保持不变),错误形如 `cli_commands.claude 只能是一行,不能有换行`。对话工具 `set_workflow` **不能**改这个字段(它是网关要执行的一行 shell,只有人能改)。
- 解析规则(`packages/gateway/src/demo/cli-launch.ts` 的 `resolveCliLaunch`):**单个词**且是可执行路径或在 PATH 上 → `via:'direct'`,直接 spawn;**其它一切**(别名 `claudeproxy`、shell 函数、带环境变量前缀的 `HTTP_PROXY=… claude`、不可执行的路径)→ `via:'shell'`,用 `$SHELL`(缺省 `/bin/zsh`)以 `-ilc '<cmd> "$@"' --` 执行,登录 + 交互所以 `~/.zprofile`、`~/.zshrc` 都会被 source,别名才存在;网关自己的参数跟在 `--` 之后,永远不拼进 shell 字符串。
  - 走 shell 时会把 `TERM_PROGRAM` 置空(macOS 的 `/etc/zshrc_Apple_Terminal` 会往 **stdout** 打 `Restored session:` / `Saving session...`,不处理会混进模型答案),另外对 stdout/stderr 再滤一遍这几行。
- 生效范围:判断/信息员大脑(`makeBrain(kind, model, { command })`)、`agent_mcp` 执行后端的每次写操作、`probeMcpConnection`(`<claude 命令> mcp get <name>`)、`POST /api/execution/connect` 弹出的终端命令(`cd ~ && <claude 命令> "/mcp"`)。运行时的 Brain 缓存键是 `kind:model:command`,**改完不用重启**,下一次判断就用新的。
- `GET /api/brains` 的每个 `BrainOption` 增加 `command: string | null`(stub 为 null)与 `resolved: { via: 'direct'|'shell', ok: boolean, detail: string }`;`available` 现在的含义是「**配置的这条命令**起得来」——direct 看 PATH,shell 看 `$SHELL -ilc 'type <命令词>'`(缓存 60 秒,`?refresh=1` 重探)。响应体同时回一份 `cli_commands`。
- `GET /api/execution` 的 `agent` 增加 `command` 与 `resolved`(操作台只读显示「启动命令:claudeproxy」),`agent_mcp` 是否可选也按这条命令是否解析得出来判断。
- 前端:设置页「CLI 启动命令」卡,三行输入框(placeholder = 默认值),失焦/回车即存,每行一个「测试」按钮跑 `POST /api/brains/test`(显示 ok / 延迟 / 错误)与一个解析徽章(直接 / 经 shell / 找不到)。

### 9.2 判断图(`GET /api/graph`、`Episode.graph`、`docs/demo/graph.md`)
- `packages/gateway/src/demo/graph.ts` 是唯一权威:节点(scan / scan:halted / review:pending_entry / review:in_position / review:closed)× 允许的模型边 × 效果 × 闸 id,以及事件边(线程状态 × 触发类型 → 节点)。`context.ts` 的允许列表、`threads.ts` 的 `allowedReviewActions`/`reduceReview`、runtime 的 `episode.graph` 都查它;`docs/demo/graph.md` 由 `npm run graph:md --workspace packages/gateway` 生成。
- 语义变化一处:紧急停止下 scan 节点的允许集从空集改为显式 `['NO_TRADE']`(eval 打分发现空集与"必须输出一个 action"的契约自相矛盾,halted case 是 evidence_valid 失败的主来源)。
- `Episode.graph = { version, node, edge, guards, illegal_action }`:`edge` 是最终走的边 id;`illegal_action` 是模型**第一次**输出的越权动作(线上会修一次再 fail-closed,但这次尝试现在被记录而不是吞掉);`guards` 是该边上评估过的闸 id(gate 中文名经 graph.ts 映射)。
- `GET /api/graph` → `{ graph: JudgmentGraph, mermaid }`,前端判断记录页用它翻译闸名与画节点/边表。

### 9.3 信息员独立页(前端,`#/intel`)
只用现有接口:`GET /api/market-state`、`/api/market-state/history?limit=`、`/api/info/events?limit=`、`POST /api/info/run-now`、`POST /api/scan-now {symbol}`;SSE `market_state.updated` 与 `activity(kind=info_update)` 由 App.tsx 统一失效 `['market-state']` / `['market-state-history']`。Agent 页右下的信息员卡缩成一行 + 「去看看」。

### 9.4 纸面账户落库
`PaperBackend` 新增 `persist: { load, save }`,每个改状态的方法末尾把 `PaperSnapshot`(version/wallet/positions/orders/closed 最近 500 条/marks/leverages)写进 `demo_kv.paper_state`(迁移 `0005_demo_kv.sql`,并把旧 `kv` 表的 demo.* 行搬过来);gateway 重启后持仓/挂单/已实现盈亏保留,线程不会再被误判"交易所侧已平"。demo/cli 后端不受影响。

### 9.5 长期记忆(v3.2,`docs/demo/memory.md`)
`GET /api/memory?status=&symbol=&limit=`、`GET /api/memory/search?q=&symbol=&regime=&tags=&limit=`、`GET /api/memory/:id`、`POST /api/memory`(用户手写,直接 active)、`POST /api/memory/:id/approve|reject|forget {reason?}`、`POST /api/memory/reflect {limit?}`(调信息员大脑,暂停时 409);SSE `memory.changed {id,status}`。`Episode.memory = { injected, cited }`;记忆在证据里显示为 `E# [记忆 mem-…·教训]`,kind `memory`。对话新增工具 `remember` / `recall` / `forget_memory`。前端页 `#/memory`。

### 9.6 执行后端(含 agent_mcp)与币安 MCP 连接(v3.3,2026-09-04 下午)

**Backend 取值扩成五个**:`paper | demo | cli | agent_mcp | mcp`(`packages/gateway/src/demo/types.ts` 的 `Backend`)。前端 `api/types.ts` 里的 `Backend` 要同步扩,并且**注意一处语义变化**:官方 binance-cli 后端过去在 `LoopView.backend` / `AccountView.backend` 里谎报成 `demo`,现在如实报 `cli`;所有 `backend === 'demo' ? 'Binance 模拟盘' : '纸面模拟'` 的三元式都要改成查表,否则 cli/agent_mcp/mcp 会被显示成"纸面模拟"。建议文案:`paper` 纸面模拟、`demo` Binance 模拟盘(tgate-demo-exec)、`cli` Binance 模拟盘(官方 binance-cli)、`agent_mcp` 币安官方 MCP(agent CLI 驱动)、`mcp` 币安 MCP 直连(网关自己调)。`mcp` 的完整语义、工具映射与路由见 §9.9。

**agent_mcp 是什么**:每一个写操作(开仓 / 止损 / 止盈 / 平仓 / 减仓 / 撤单 / 撤单一笔 / 改杠杆 / 改保证金模式)= 启动一次 agent CLI(`claude` 或 `codex`),给它一份**只做这一件事**的任务 JSON,要求它只用币安官方 MCP 服务器(`https://agent.binance.com/mcp/agentic`)的工具,最后只回一个 JSON。工具名和参数**没有写死**,由 agent 自己发现,所以币安改工具不用改网关。网关不持有任何币安 API key,也不持有 OAuth token —— token 在 CLI 自己的登录态里。

代价:**每一次没命中缓存的调用 = 一次 CLI 运行(= 一次模型会话)**。因此读接口分两类:
- `markPrice` / `symbolRules` / `symbols` 走公开 REST(`market.ts`),不花 CLI 运行;
- `account()` 花一次,缓存 `TG_EXEC_AGENT_ACCOUNT_TTL_MS`(默认 300000 ms),**任何写操作后立即失效**;
- `getOrder()` 花一次,按 client_order_id 缓存 30 秒。
超时 120 秒(`TG_EXEC_AGENT_TIMEOUT_MS`),超时会 kill 子进程并把结果记为 `unknown`(不是 `failed`);输出里找不到 JSON 对象也记 `unknown`,原文进 `error`。`unknown` 会被现有的「没有状态不明的订单」闸和对账逻辑接住。

**Workflow 新字段**(`GET/POST /api/workflow`):
- `execution: 'paper' | 'demo' | 'cli' | 'agent_mcp'` —— 默认值 = 网关启动时实际选中的后端(`TG_DEMO_BACKEND`),不是持久化里的旧值;这个字段**永远等于正在跑的后端**。
- `exec_agent_cli: 'claude' | 'codex'`(默认 `claude`)。
- `exec_agent_model: string | null`(默认 null → claude 用 `sonnet`,codex 用它自己的默认);校验同 `brain_model`,`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$`。

**切换后端**:`POST /api/workflow {"execution":"agent_mcp"}` 会真的去切(停旧的、起新的、刷账户)。**只有在没有进行中的线程(pending_entry / in_position)且没有状态不明的订单时才允许**;被拒时后端不动、`workflow.execution` 保持原值,原因放在响应的 `errors` 数组里(接口仍然 200)。持仓和挂单**不会**跟着后端走,所以这条限制是硬的。`POST /api/settings` 走同一条路(它失败时返回 400 + `errors`)。

**`GET /api/execution`**(以及强制重测的 `POST /api/execution/check`)→
```json
{
  "backend": "paper",
  "options": [{ "kind": "paper", "label": "纸面模拟(本地撮合)", "available": true, "note": "…" }],
  "agent": { "cli": "claude", "model": null, "server_name": "binance-mcp-server", "url": "https://agent.binance.com/mcp/agentic" },
  "connection": { "status": "connected|needs_auth|unavailable|unknown", "checked_at": 1757000000000, "detail": "Status: ✓ Connected" },
  "can_switch": true,
  "switch_blocker": null
}
```
- `options` 恒为 4 条,顺序 `paper / demo / cli / agent_mcp`;`available` = 这个进程注册了该后端的工厂(缺二进制/缺配置就没注册),`agent_mcp` 还要求所选 CLI 在 PATH 上;当前正在跑的那个恒为 `true`。
- `connection` 是**探测缓存**(60 秒):claude 走 `claude mcp get <server_name>`,cwd = 用户 home(Jacky 就是在那儿注册的),输出含 "Needs authentication" → `needs_auth`,含 "Connected"/"✓" → `connected`,非零退出/CLI 不在 → `unavailable`,读不懂 → `unknown`。**codex 恒为 `unavailable`**,`detail = "Codex 的 MCP OAuth 只支持动态注册,币安只支持 CIMD;等 Codex 支持后再用"`(`codex mcp add` 能加上,但 `codex mcp login` 报 "Dynamic client registration not supported");选项仍可选,只是连不上,不会真去 spawn。第一次调用可能要等几秒(要起一次 `claude mcp get`)。
- `can_switch` / `switch_blocker` 与上面的切换限制一致(`switch_blocker` 是中文原因,可直接展示)。

**`POST /api/execution/connect`** → `{ started: boolean, instructions: string }`(codex 另带 `detail`)。两种 CLI 都**不会**在后台起登录进程:claude 没有无头登录命令,返回 `started:false` + `"在终端 cd ~ && claude,输入 /mcp,选择 binance-mcp-server 完成登录;登录一次后网关复用该会话"`;codex 返回 `started:false` + 上面那条 CIMD 说明。

**SSE**:新增事件 `execution.changed`,负载就是 `GET /api/execution` 的同一个对象;切换成功后、以及连接状态发生变化时各发一次。**ActivityKind 新增 `execution_changed`**(level `warn`)。

环境变量:`TG_DEMO_BACKEND=agent_mcp` 启动即用该后端;`TG_EXEC_AGENT_CLI` / `TG_EXEC_AGENT_MODEL` 设初值;`TG_BINANCE_MCP_NAME` / `TG_BINANCE_MCP_URL` 换服务器名与地址(名字必须和人工登录时用的一致,token 才会被复用)。

### 9.7 每日判断上限与今日用量(v3.3)

**Workflow 新字段 `daily_judgment_cap: number`**(默认 300,范围 0–5000,**0 = 不限**)。含义:**按本地日历日**(不是 UTC)统计 `demo_episodes` 里今天的条数;到达上限后,扫描 / 持仓复查 / 信息员的模型调用**直接跳过**(`scan()` / `reviewThread()` / `runInfoNow()` 返回 false,不入队、不写 episode)。**用户在对话里问问题不受限制**,手动 `POST /api/memory/reflect` 也不受限制。

跳过时最多**每 10 分钟**写一条日志(scope `cap`)+ 一条活动流条目,**ActivityKind 新增 `cap_reached`**(level `warn`,title 形如「今日判断已达上限 300 次,后续判断已跳过」),不会每个被跳过的触发都刷一条。定时信息员被跳过时会按 `info_every_ms` 重新排期(第二天自然恢复)。

**`GET /api/overview` 新增 `usage_today`**:
```json
{ "judgments": 662, "input_tokens": 866000, "output_tokens": 160000, "est_cny": 3.012, "cap": 300, "capped": true }
```
- `judgments` = 今天(本地日)的 episode 条数,也就是被 cap 计数的那个数;`input_tokens` / `output_tokens` 从 episode 的 `usage` 里 SUM 出来。
- `est_cny` 是**估算**,按 `brain.ts` 的价目表(每 100 万 token 人民币):`pi:zai/glm-5.3` 输入 ¥2 / 输出 ¥8,`pi:deepseek/deepseek-v4-flash` ¥1 / ¥2;claude、codex 走订阅额度**没有单价**,所以只用了订阅模型的一天 `est_cny` 为 `null`(前端显示「订阅额度,不计费」,不要显示 ¥0)。
- `capped` = `cap > 0 && judgments >= cap`;为真时前端应在顶栏提示「今日判断已达上限,自动判断已停;调高上限或等明天」。

### 9.8 回放与盲测(v3.4,2026-09-05)

**要解决的事**:Jacky 的问题是「它的入场到底靠不靠谱」。回答的唯一诚实方式是让 agent 在历史上再判断一遍,**但不许看见未来的 K 线**。所以有两件东西:一个 TradingView 式的 K 线回放器(纯前端,免费),和一个盲测引擎(每根候选 K 线调一次模型,**要花钱**)。设计与「哪些是盲的、哪些不是」见 `docs/design/blind-backtest-2026-09-05.md`。

**盲测不变式**:在收盘时刻 T 的那次判断里,喂给 `buildContext()` 的每一根 K 线都满足 `close_time ≤ T`,所有派生数字(EMA/ATR/摆动高低、日线状态、24h 涨跌、触发器)都只由这些 K 线算出。引擎每一步都断言这一点(`assertBlind`),测试再从模型实际收到的上下文里把 K 线时间解析出来复核一遍。判断链路本身**不是复制品**:同一个 `buildContext`(同 `PROMPT_VERSION`)、同一个 JSON 契约校验 + 一次修复轮、同一张判断图、同一个 `gates.ts`、复查同一个 `reduceReview`。

**钱**:GLM-5.3 一次判断 ≈ ¥0.006。前端**必须**先调 estimate、把 ¥ 数字放进确认框念一遍,用户确认后才 POST。回测**不受 `daily_judgment_cap` 约束**(它是用户主动发起的),它的花费也**不进** `usage_today`,只在 run 的 `summary.cost` 里单独算;回测判断不写 `demo_episodes`。同一时刻只跑一个回测,第二个请求 409。

#### 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/backtest/estimate?symbol&timeframe&from&to&mode&max_judgments&review_every_close` | 不调模型,只数候选 K 线并按 `brain.ts` 价目表估价 |
| POST | `/api/backtest` | body 同 estimate 的 query;→ 202 `{ run, error }`,已有回测在跑时 409 + `error` |
| GET | `/api/backtest?limit=50` | → `{ runs: BacktestRun[], running: string \| null }`(倒序) |
| GET | `/api/backtest/:id` | → `{ run, steps, trades }` |
| POST | `/api/backtest/:id/cancel` | → `{ cancelled: boolean }`(在两步之间生效) |
| GET | `/api/market/klines/history?symbol&interval&from&to` | 回放图的历史 K 线,单页 ≤ 1500 根,落盘缓存到 `~/.trade-gate/demo/klines/<symbol>-<tf>.json`,重复回放不再请求币安 |

```jsonc
// GET /api/backtest/estimate
{ "symbol": "BTCUSDT", "timeframe": "15m", "from": 1788, "to": 1788, "mode": "triggers",
  "bars": 672,            // 区间里的 K 线根数
  "candidates": 41,       // 触发器命中的根数(every_close 模式 = bars)
  "per_judgment_cny": 0.0064, "est_cny": 0.262, "max_cny": 0.384,   // 订阅制大脑三个都是 null
  "model": "pi:zai/glm-5.3",
  "note": "…复查(持仓期间)不在候选数里,所以实际次数可能更多,上限就是 max_judgments" }

// GET /api/backtest/:id
{ "run": { "id": "bt-…", "created_at": 1788, "symbol": "BTCUSDT", "timeframe": "15m",
           "from_ms": 1788, "to_ms": 1788, "mode": "triggers|every_close",
           "status": "queued|running|done|failed|cancelled",
           "params": { "max_judgments": 60, "review_every_close": false, "horizon_bars": 48, "risk_pct": 0.5, "max_opens_per_day": 2, "brain": "pi", "brain_model": null },
           "brain": "pi:zai/glm-5.3", "prompt_version": "demo-playbook-v4",
           "progress": { "done": 12, "total": 41, "last_action": "WATCH", "at": 1788 },
           "summary": { "judgments": 41, "scans": 33, "reviews": 8,
                        "actions": { "NO_TRADE": 24, "WATCH": 11, "PROPOSE": 3, "HOLD": 3 },
                        "trades": 3, "wins": 2, "losses": 1, "flat": 0, "win_rate": 0.67,
                        "avg_r": 0.42, "sum_r": 1.27, "max_drawdown_r": 1.0, "avg_hold_bars": 9.3,
                        "cost": { "input_tokens": 66000, "output_tokens": 16000, "cny": 0.26 },
                        "model": "pi:zai/glm-5.3",
                        "missed_move": { "samples": 35, "avg_atr": 1.4, "max_atr": 3.2 },
                        "bars": 672, "candidates": 41, "capped": false,
                        "trade_rows": [ /* BacktestTrade[] */ ] },
           "error": null },
  "steps": [ { "run_id": "bt-…", "idx": 0, "at_ms": 1788, "kind": "scan|review",
               "trigger": "breakout:15m 收盘 … 突破前 20 根高点 …",
               "visible_upto_ms": 1788,          // 盲测边界,恒等于 at_ms
               "judgment": { /* Judgment */ }, "action": "PROPOSE", "direction": "long", "confidence": 0.62,
               "gates": [ /* GateResult[] */ ],
               "outcome": { "kind": "opened|blocked|closed|reduced|none", "detail": "…", "trade_step_idx": 0, "r": 1.85, "missed_move_atr": 1.2 },
               "cost": { "input_tokens": 1600, "output_tokens": 400, "cny": 0.006 },
               "error": null } ],
  "trades": [ { "step_idx": 0, "direction": "long", "entry": "market", "limit_price": null,
                "proposed_at": 1788, "fill_at": 1788, "fill_price": 104.9, "stop": 103.8, "tp": 107.1,
                "exit_at": 1788, "exit_price": 107.1,
                "status": "stop|tp|review_exit|expired|unfilled|open", "close_reason": "触及止盈",
                "r": 2.0, "mae_r": -0.4, "mfe_r": 2.1, "bars_held": 9,
                "reduced_fraction": 0, "reduced_r": null } ] }
```

`trades` 与 `run.summary.trade_rows` 是同一个数组(前者是便利字段)。成交语义与 eval 的 `simulateOutcome` **同一份实现**(现在住在 `packages/gateway/src/demo/outcome.ts`,eval-a 只是别名):市价单按**下一根开盘**成交;限价单在触及的那根按限价(跳空则按开盘)成交;同一根同时触及止损与止盈按**止损**算;跳空穿越按开盘价出;到 `horizon_bars` 未了结按收盘价出。复查(HOLD/REDUCE/EXIT/INVALIDATE)发生在**该根收盘之后**,所以 K 线内的止损止盈先生效,再轮到模型说话 —— 复查同样是盲的。

**SSE**:新增 `backtest.progress` `{ run_id, done, total, last_action, at }`(每次判断一条)与 `backtest.changed`(负载 = `BacktestRun`)。前端 key:`['backtest']`、`['backtest', id]`、`['klines-history', symbol, interval, from, to]`。

**前端页 `#/replay`(侧栏「回放」)**:上面币种/周期/起止时间 +「加载」;中间蜡烛图带**游标**(拖动条 + 播放/暂停/前后一根 + 1×/5×/20×),只画 `bars[0..cursor]`;判断标记与模拟持仓的价格线**只在游标经过之后才出现**(盲测的可视化);右侧判断列表与游标联动(点一行跳过去,游标之后的行变淡);下面是回测表单(mode / max_judgments / 复查频率 →「估算」→ 带 ¥ 的确认框 →「开始回测」)与汇总卡。

### 9.9 币安 MCP 直连(mcp 后端)与工具映射(v3.4,2026-09-05)

**`mcp` 与 `agent_mcp` 的区别**:`agent_mcp`(§9.6)每个写操作要启动一次 agent CLI(占订阅额度、10–30 秒、回执靠模型转述);`mcp` 是网关自己持有 OAuth token,直接对币安 Agentic MCP 服务器发 JSON-RPC——一笔单 = 一次 HTTP,零模型成本,回执就是交易所原文。两者的 token 来源也不同:`agent_mcp` 借用 CLI 自己的登录态,`mcp` 走 `binance-oauth.ts` 的 PKCE + CIMD,token 存 `demo_kv`(`binance.oauth.token`)。前端 `BACKEND_LABEL` 需加 `mcp: '币安 MCP 直连'`。

**工具映射(tool map)**:`mcp` 后端不写死任何币安工具名——币安没有公开工具文档,连 `tools/list` 都要先有 token 才能拿到。映射存在 `demo_kv` 的 `binance.mcp.map`(工具清单快照另存一份在 `binance.mcp.tools`),形状:

```json
{
  "version": 1,
  "status": "proposed|confirmed",
  "source": "heuristic|manual",
  "updated_at": 0,
  "ops": {
    "place_market": {
      "tool": "futures_um_place_order",
      "args": { "symbol": "${symbol}", "side": "${side}", "type": "MARKET", "quantity": "${qty}", "newClientOrderId": "${clientOrderId}", "reduceOnly": "${reduceOnly}" },
      "result": { "order_id": "orderId", "avg_price": "avgPrice", "status": "status", "executed_qty": "executedQty" },
      "confidence": 1,
      "missing": []
    }
  },
  "notes": ["…"]
}
```

13 个 op:`account` / `positions` / `open_orders` / `place_market` / `place_limit` / `place_stop_market_close` / `place_take_profit_close` / `cancel_order` / `cancel_all` / `get_order` / `set_leverage` / `set_margin_type` / `mark_price`。可选 op(缺了也能跑):`mark_price`(退回公开 REST premium index)、`positions`、`open_orders`(退回 `account` 返回里自带的数组)。其余为必需——没映射就直接返回 outcome `failed`,错误「该操作未映射:\<op\>」,绝不猜工具名。

占位符共 11 个:`symbol` / `side` / `positionSide` / `qty` / `price` / `stopPrice` / `clientOrderId` / `leverage` / `marginMode` / `reduceOnly` / `closePosition`。渲染规则:值恰好是 `${x}` 时按原类型注入(数字仍是数字),嵌在更长的字符串里则做插值;本次调用没有该值时,整个键被丢掉(所以同一条 `place_*` 模板既能下普通单,也能下 reduceOnly 单,取决于调用方有没有传 `reduceOnly`);字面量 `null` 也会被丢掉;出现未知占位符名是校验错误。`result` 是 jsonpath-lite,写法如 `orderId`、`data.orderId`、`data.orders.0.orderId`;单段路径(如 `orderId`)在精确路径找不到时会退化成大小写/下划线不敏感的递归查找,所以 `orderId` 也能命中 `{"data":{"order_id":7}}`。另有可选的 `result.root`,指出读操作载荷的根(例如 `"data"`)。

**自动发现**:OAuth 回调成功后(以及任何时候手动 `GET /api/binance/tools`),网关自动跑一次 `tools/list`,落 `binance.mcp.tools`,再按启发式(工具名 / 描述 / `inputSchema` 参数名里的关键词打分,USDⓈ-M 永续加分、现货/期权/杠杆倒扣分)生成 `status: 'proposed'` 的映射草案;每个 op 带 `confidence`(0–1)和 `missing`(该工具没声明、但这个操作需要的参数)。**已经被人工确认过的映射不会被覆盖**——只要它引用的每个工具在新清单里都还在,就原样保留;只要有一个工具消失了,就整份重新出草案,并要求重新确认。

**路由**(都在 `http.ts` 的 Binance 块里):
- `GET /api/binance/map` → `{ map, tools_count, tools_at, proposal_notes: string[], unmapped_required: op[], ops: op[], placeholders: string[], review_prompt: string|null }`。`review_prompt` 是一段可以直接交给人(或订阅制 CLI)校对的提示词,里面带工具清单和当前草案。
- `POST /api/binance/map/propose` → 重新推断。能连上就先刷新工具清单(返回里 `refreshed: true`),连不上就用上次的快照重推;两者都没有则 409(未授权时 401)。返回同 `GET`,多一个 `refreshed`。
- `PUT /api/binance/map` → 用人工编辑过的 JSON 整体替换(body 既可以是映射本身,也可以是 `{ map: … }`)。校验 op 名合法、`tool` 非空、`args` 的值只能是 string/number/boolean/null、占位符必须是已知的 11 个之一、`result` 的键只能是 `order_id`/`avg_price`/`status`/`executed_qty`/`root` 这五个。不通过返回 400 + `errors[]`。**body 里没写 `status` 就落为 `proposed`**——也就是说改完必须重新走一遍确认。
- `POST /api/binance/map/confirm` → 置 `status: 'confirmed'`;还有必需 op 没映射时 400。
- `POST /api/binance/map/test`(body 可选 `{ symbol }`,默认取 watchlist 第一个)→ **只跑只读的四个 op**(`account`/`positions`/`open_orders`/`mark_price`),永远不写,`status` 还是 `proposed` 时也能跑——就是给人在确认前核对用的。返回 `{ symbol, results: [{ op, tool, ok, ms, args, sample, error }], ok_count, total }`,`sample` 是回包 JSON 的前 600 个字符,方便人肉眼核对字段名。
- 这几个路由(propose/confirm/PUT)都会广播 `execution.changed`。CORS 允许方法新增 `PUT`。

**`GET /api/execution` 的 `options` 恒为 5 条**(顺序 `paper / demo / cli / agent_mcp / mcp`),新增一项 `{ kind: 'mcp', label: '币安 MCP 直连(网关自己调)', available, note }`。`available` 要求同时满足:该进程注册了 `mcp` 工厂、配了 `TG_BINANCE_OAUTH_CLIENT_ID`、token 有效、且映射 `status === 'confirmed'`;不可用时 `note` 直接给原因(未配 client_id / 还没连接币安 / 还没有工具映射 / 映射还没确认),可以原样展示给用户。

**语义与安全**:
- 写操作的失败分两类。渲染模板出错、没 token、工具返回 `isError`、JSON-RPC error,都算 `failed`(交易所明确说了「不」);网络错误 / 超时 / HTTP 层错误算 `unknown`(可能已经到了交易所),交给既有的对账逻辑去处理,不当成失败。
- 交易所回执 `status` 落 REJECTED/EXPIRED → `failed`,FILLED → `filled`,其余 → `submitted`。
- `get_order` 遇到 -2013 / "does not exist" 视为「这单已经没了」,返回 `null`,不抛错。
- `placeStop` / `placeTakeProfit` 用 `closePosition=true` 且不带数量(币安不允许 `closePosition` 和 `reduceOnly` 同时出现);`closePosition()` 先读一次持仓再下 reduceOnly 市价单:确实没有持仓时算已经平了(`closed: true`,回执带 `note: "no position"`),但**读账户这一步失败**时返回 `closed: false` + 原因,绝不把「读不到」当成「已经平了」。
- `account` 缓存 10 秒(`TG_BINANCE_MCP_ACCOUNT_TTL_MS`),`getOrder` 缓存 5 秒,任何写操作后账户缓存立即失效;`markPrice`/`symbols`/`symbolRules` 走公开 REST,不占 token 额度。
- 默认 `positionSide` 发 `BOTH`;`TG_BINANCE_MCP_HEDGE=1` 时才发 `LONG`/`SHORT`。

**环境变量**:`TG_DEMO_BACKEND=mcp` 可以直接启动,但映射还没 `confirmed` 时网关会打一行警告并退回 `paper` 启动,避免因为映射没确认而反复重启失败。

### 9.10 指标(v3.5,2026-09-05)

模型过去能看到的技术面只有 EMA20/50、ATR14、20 根高低、量比四样。现在从 8794 控制台移植了整个指标库(`packages/gateway/src/demo/indicators.ts`,35 个指标族,逐条口径与移植取舍见 `docs/demo/indicators.md`),三条路同时接出去:证据、接口、图表叠加。

**证据**:`tfFeatures()` 顺手算一份 `IndicatorSnapshot` 挂在 `TfFeatures.indicators` 上,「扫描清单(代码计算)」那条证据因此多一行五格——`RSI14`、`ADX14(趋势强弱)`、`BB宽 N 分位`(90 根)、`挤压 是(N 根)/否`、`距VWAP ±N.NN ATR`。同一行的 ATR% 门槛也从写死的 0.4 % 改成**按周期分档**(`ATR_PCT_FLOOR`:1m 0.04 / 5m 0.08 / 15m 0.15 / 30m 0.2 / 1h 0.3 / 4h 0.6 / 1d 1.5,表外周期按 `0.08 % × √(分钟/5)` 兜底)——原来那个 0.4 % 是 4h 的门槛套在 5m 上,5m 几乎永远「不足」。清单全文仍 ≤ 320 字。`scanChecklist()` 的旧单参数调用照常工作。

**`GET /api/market/indicators`**

查询参数:`symbol`(默认 watchlist 第一个)、`interval`(也接受 `tf`,默认 `1h`)、`limit`(默认 300,20–1000)、`end_time`(可选,毫秒)、`set`(逗号分隔;`all` = 全开;缺省 = `ema20,ema50,bb,vwap,rsi,macd,adx,supertrend,donchian`)。

网关**多取 260 根热身**再把它们裁掉,所以窗口第一根上的 EMA200 / 一目均衡表已经收敛,不是半热身的假值。

```json
{
  "symbol": "BTCUSDT", "interval": "1h", "bars": 300,
  "klines_from": 1767139200000, "klines_to": 1768215600000,
  "sets": ["ema20", "bb", "..."],
  "unknown_sets": [],
  "overlay": ["ema20", "bb"],
  "series": {
    "ema20":      [{ "t": 1767139200000, "v": 63512.41 }],
    "bb":         [{ "t": 0, "mid": 0, "upper": 0, "lower": 0, "width_pct": 0 }],
    "donchian":   [{ "t": 0, "upper": 0, "lower": 0, "mid": 0 }],
    "keltner":    [{ "t": 0, "mid": 0, "upper": 0, "lower": 0 }],
    "macd":       [{ "t": 0, "macd": 0, "signal": 0, "hist": 0 }],
    "adx":        [{ "t": 0, "adx": 0, "plus_di": 0, "minus_di": 0 }],
    "stoch":      [{ "t": 0, "k": 0, "d": 0 }],
    "supertrend": [{ "t": 0, "value": 0, "dir": 1 }],
    "psar":       [{ "t": 0, "value": 0, "dir": -1 }],
    "ichimoku":   [{ "t": 0, "tenkan": 0, "kijun": 0, "cloud_top": 0, "cloud_bottom": 0 }],
    "squeeze":    [{ "t": 0, "on": true, "bars_on": 7 }],
    "aroon":      [{ "t": 0, "up": 0, "down": 0, "osc": 0 }]
  },
  "snapshot": { "tf": "1h", "trend": "up", "trend_strength": "moderate", "rsi14": 58.2, "…": 0 },
  "text": "1h:趋势 上升(ADX 27.4/中);RSI14 58.2;…",
  "volume_profile": { "poc": 63120, "vah": 63980, "val": 62410 }
}
```

要点:

- `t` 是 K 线**开盘时间的毫秒**(和 `/api/market/klines` 一致);lightweight-charts 要的是秒,前端自己除。
- **预热期的点根本不发**。JSON 没有 NaN,与其发 `null` 或 0(0 是个可以被当成真数字引用的值),不如让每条线各自从算得出来的那一根开始。所以各条线起点不同、长度不同,只能**按 `t` 对齐,不能按下标**。
- `unknown_sets` 把认不出的名字原样回报,不静默吞掉;一个都认不出时退回默认集合,而不是给一张空图。
- `overlay` 告诉前端哪些该画在主图价格轴上,其余的该进副窗。
- `set` 可用的名字全集见 `GET /api/market/indicators/sets` → `{ sets, overlay, defaults }`,前端不用把名字写死。
- 除了序列,响应里还顺带给 `snapshot`(全部指标的最后值)、`text`(`describeIndicators()` 的一行中文,≤ 220 字)、`volume_profile`(POC / VAH / VAL)。

路由文件是 `packages/gateway/src/demo/routes-indicators.ts`,按扩展点约定在 `http-extra.ts` 里只占一行。

**前端叠加层**:`src/components/indicator-overlays.ts` 导出 `useIndicatorOverlays(chart, series, symbol, interval, options?)`——所有对 chart 的增删改都关在这个文件里,`trade-chart.tsx` 只负责把 `enabled` / `toggle` 画成一排 chip。主图 chip:EMA20 / EMA50 / BB / VWAP / 超级趋势 / 唐奇安(可任意多开);副窗 chip:RSI / MACD(lightweight-charts v5 的多窗格可用,但**同时只开一个**——两个副窗会把 300 px 高的交易页图挤没,而且只留一个的话窗格索引恒为 1)。选择记在 localStorage(`tg.chart.overlays` / `tg.chart.subpane`),默认 `ema20,ema50`。`TradeChart` 新增可选属性 `showOverlays`(默认 `true`),复盘页那张自管叠加的图可以关掉这排 chip。

### 9.11 策略库(v3.5,2026-09-05)

**要解决的事**:到 v3.4 为止,agent 只有**一条**策略,而且它是 workflow 里的一段自由文本(`playbook_text`)。改一个数字没有版本、没有 hash、没有「改之前它的成绩是什么」,所以既没法回答「这次是哪条策略赚的钱」,也没法把回测发现的问题变成一次可回滚的改动。v3.5 把策略变成**不可变的版本化对象**,并把 Jacky 那套流程缺的三步补上:回归概率(第 2 步)、按策略归属(第 4 步)、归因与改进(第 5–6 步)。模型设计见 `docs/design/strategy-library-2026-09-05.md`。

**红线**:没有任何一条路由能改一个在跑的策略的数字。改参数 = 生成一个 `draft` 新版本(新 `content_hash`),上线 = 一格一格晋升,`paper → live_capped` 必须带人工确认。归因只 `propose`(写 `demo_backtest_attribution` + 一条 `proposed` 长期记忆),永不 apply —— 与 design v1 §11「记忆不改数字」同一条纪律。

#### 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/strategies?include_retired=1` | → `{ strategies: StrategyView[], active, statuses, status_labels, family_labels }`,每条是该 id 的 head 版本 |
| GET | `/api/strategies/:id` | → `{ strategy, versions, attributions }` |
| POST | `/api/strategies/active` | body `{ ids }` → 写 `workflow.active_strategies`;**任一 id 不到 `paper` 就整体 400** |
| POST | `/api/strategies/:id/propose-version` | body `{ params?, rules?, name?, attribution_id? }` → 201 `{ strategy }`(状态一律 `draft`) |
| POST | `/api/strategies/:id/promote` | body `{ to, confirm? }` → 200 / 409 + 中文原因;只准往前一格 |
| POST | `/api/strategies/:id/retire` | → `{ strategy, active }`,同时把它踢出实盘启用列表 |
| GET | `/api/backtest/:id/attribution` | → `{ points: AttributionPoint[] }` |
| POST | `/api/backtest/:id/attribute` | 调**便宜大脑**跑归因(花钱);已有结果时 `{ cached: true }` 直接返回;run 未 `done` 时 409 |

```jsonc
// GET /api/strategies → strategies[0](StrategyView = StrategySpec + 四个界面字段)
{ "id": "breakout_retest", "version": 1, "content_hash": "9f2c…", "name": "突破-回踩",
  "family": "trend_continuation", "status": "paper",
  "trigger": { "kinds": ["breakout", "retest", "ema_cross"], "min_timeframe": "15m", "cooldown_bars": 4 },
  "checklist": { "required": ["scan_checklist", "daily_regime"], "timeframes": ["15m", "1h", "4h"] },
  "rules": { "entry": ["…"], "invalidation": ["…"], "exit": ["…"], "sizing_note": "…" },
  "params": { "chase_atr_max": { "value": 1.5, "min": 0.5, "max": 3, "unit": "ATR", "note": "距突破位多远就不追" } },
  "eval_stats": { "backtests": 2, "trades": 24, "win_rate": 0.5, "expectancy_r": 0.42,
                  "mae_r_p50": -0.4, "last_run_id": "bt-…", "noise_note": "单次采样,噪声底 ~30%" },
  "created_at": 1788, "parent_version": null,
  // 界面字段(库里不存)
  "family_label": "趋势延续", "status_label": "纸面", "next_status": "live_capped",
  "promote_blocked": "进限额实盘必须人工确认(confirm=true)",   // null = 可以点晋升
  "active": true }

// GET /api/backtest/:id/attribution → points[0]
{ "id": "attr-…", "run_id": "bt-…", "at": 1788, "strategy_id": "breakout_retest", "symbol": "BTCUSDT",
  "kind": "param",                       // rule_wording | param | checklist_item
  "title": "追单太远",
  "evidence_said": "清单写着距突破位 1.4 ATR",
  "rule_said": "1.5 ATR 以内可以追",
  "actual": "两笔都在入场后立刻回抽打止损",
  "proposal": { "kind": "param", "strategy_id": "breakout_retest", "param": "chase_atr_max", "value": 1,
                "text": "chase_atr_max:1.5ATR → 1ATR" },
  "memory_id": "mem-…",                  // 对应的 proposed 记忆,等人批准
  "applied_version": null }              // 人点了「生成新版本」之后是那个版本号
```

**晋升门**(`promote_blocked` 就是这几句的中文):`draft → backtest` 只要对象合法;`backtest → shadow` 要 `eval_stats.backtests ≥ 1` 且 `trades ≥ 20`;`shadow → paper` 要 `expectancy_r > 0`;`paper → live_capped` 要 `confirm: true`。退役随时可以,不可回 —— 想复活就生成新版本。

**SSE**:复用已有的 `strategy.changed`(不新增事件名),负载是 `{ id, version, status }` 或 `{ active }`。前端 key:`['strategies']`、`['strategies', id]`、`['backtest', id, 'attribution']`;`strategy.changed` 按前缀 `['strategies']` 一次全失效。

**前端页 `#/strategies`(侧栏「策略库」,排在「回放」之后)**:每条策略一张卡(族 / 状态徽标 / 版本 + hash 前 8 位 / 触发种类 / 规则前两行 / `eval_stats` 一行),按钮「启用·停用」(写 `active_strategies`,未到 `paper` 的开关置灰并注明原因)、「晋升」(`promote_blocked` 非 null 时置灰并把原因显示出来;到 `live_capped` 用 `requireText="LIVE"` 的危险确认框)、「退役」、「查看版本」;抽屉里是完整规则、参数表(值 / 范围 / 说明)、清单、版本列表,以及这条策略的归因提案 + 每条一个「生成新版本」。

#### §9.8 的增补(回放页)

- `BacktestParams` 新增 `strategy_ids: string[]`(默认 = `workflow.active_strategies`;回测**允许**点名 `backtest` / `shadow` 状态的策略,那正是回测的用途)与 `attribute: boolean`(跑完自动归因)。`GET /api/backtest/estimate` 的 query 收逗号分隔字符串,`POST /api/backtest` 收数组。
- `BacktestEstimate` 新增 `candidates_by_strategy: Record<string, number>` —— 每条策略自己的触发集合会唤醒多少根,**不调模型**就能算。
- `BacktestSummary` 新增 `strategies: { id, version, content_hash, status }[]`(这次测的到底是哪份内容)与 `by_strategy: Record<string, { trades, wins, losses, win_rate, expectancy_r, sum_r, mae_r_p50, proposals }>`;模型没标注策略的成交进 `unattributed` 桶。
- `BacktestStep` 与 `BacktestTrade` 各新增 `strategy_id: string | null`。
- 回测跑完会把 `by_strategy` 的成绩写回各策略 head 的 `eval_stats`(`backtests` 累加,其余覆盖成最近一次,`noise_note` 恒为「单次采样,噪声底 ~30%」)。**写的是统计,不是内容**:版本号与 `content_hash` 不动。
- 回放页表单多了策略多选(默认 = 当前启用)与「跑完自动归因(便宜大脑)」开关;汇总卡下面多一张按策略拆的小表,再下面是「归因」面板(问题点位 + 「采纳为新版本」)。

#### `PROMPT_VERSION` 与判断契约

`demo-playbook-v4` → **`demo-playbook-v5`**。变化只有两处:

1. 上下文里 `playbook_text` 那一段被换成「可用策略:」+ 本次被唤醒的策略的规则块,原来的 `playbook_text` 降级成后面的「补充说明(用户写的,不覆盖策略)」。**没有启用任何策略时,渲染与 v4 完全一致**(还是 `Playbook(…)` + 全文),所以录好的 eval case 照样能跑。
2. 多一条硬红线 9:`PROPOSE` 必须在 JSON 里给 `strategy_id`,且必须是本次列出的策略之一。缺了或不认识 → 契约错误 → 走**同一轮**修复,再不行 fail-closed(scan 判 `NO_TRADE`)。`WATCH` / `NO_TRADE` / 复查动作不必填。

`Judgment` 因此多一个可选字段 `strategy_id: string | null`,线程与回测步骤都记下它。提示词膨胀:两条策略同时启用时约 +900 字,其中约 60 字是与条数无关的固定开销。

### 9.12 筛选(Radar)与团队注册表(v3.6,2026-09-05)

设计:`docs/design/screener-radar-2026-09-05.md`。写操作只有 run 与 apply;apply 只改 `workflow.watchlist`。

- `GET /api/screener/latest?horizon=short|swing|weekly` → `{ horizon, screen: ScreenRow|null, candidates: WatchCandidate[], schedule: { horizon, label, every_ms, last_at, next_at, running, enabled, progress }[], watchlist, watchlist_max, horizons: {id,label}[] }`。`screen` 是该周期**上次成功**的一次;失败的只出现在 history。
- `GET /api/screener/history?horizon=&limit=20` → `{ screens }`;`GET /api/screener/:id` → `{ screen, candidates }`。
- `POST /api/screener/run {horizon}` → 202 `{ horizon, paused_note }`(异步;进度走 SSE `screener.changed {screen_id, horizon, status:'running', done, total}`,完成 `status:'done'|'failed'`);同周期已在跑 → 409 `already_running`。暂停时允许手动跑但不调模型。
- `POST /api/screener/:id/apply` → `{ workflow, before, after }`;失败(无提案 / 未完成 / 不存在)→ 409 `apply_rejected`。
- workflow 字段(经现有 `POST /api/workflow`):`screener_enabled`、`screener_short_every_ms`、`screener_swing_every_ms`、`screener_universe`('watchlist+whitelist'|'top_volume'|'explicit')、`screener_symbols`、`screener_max_symbols`(1–300)、`screener_use_brain`、`screener_apply`('propose'|'auto')、`screener_expectancy`。`watchlist_max` 是常量 8,不可改。周线固定 7 天。
- `GET /api/bots` → `{ bots: (BotProfile & { presence })[], runs: BotRun[](20), handoffs: BotHandoff[](20,新在前), horizon_labels }`。`presence = { state: idle|thinking|working|waiting|blocked|done|off, action, since, next_at }` 由代码从运行时状态推导,不落库、模型不能写。`GET /api/bots/runs?role=&routine=&limit=`、`GET /api/bots/handoffs?status=pending|acked&to_role=&limit=`(payload 原样返回;radar 的 payload = `{ proposal, top }`)、`POST /api/bots/handoffs/:id/ack` → `{ handoff }`。
- SSE 新增 `screener.changed`、`bots.changed`;活动流新增 `screen_done` / `screen_failed`。

### 9.13 团队五角色(v3.7,2026-09-06)

设计与分歧处置:`docs/design/team-roles-2026-09-06.md`。全部零模型,除 Reviewer 批次(便宜大脑 ≤ 2 次/天)。

- Portfolio:`GET /api/portfolio/snapshot` → `{ snapshot: PortfolioSnapshot|null, policy, default_policy, cluster_map_version, watchlist_clusters }`;`GET /api/portfolio/history?limit=`;`GET /api/portfolio/snapshot/:id`;`POST /api/portfolio/impact {symbol, side, qty, price?, stop?}` → `{ impact: { verdict: pass|warn|block|unavailable, reasons, before, after, headroom } }`。
- Risk:`GET /api/risk/alerts?status=open|resolved|all` → `{ alerts: RiskAlertRow[], level, blocks_new_risk }`;`POST /api/risk/alerts/:id/ack`(已阅,不解除);`POST /api/risk/alerts/:id/resolve`(只有 `recovery_ready` 的 high/critical 能关,否则 409);`POST /api/risk/evaluate`;`GET/POST /api/risk/policy`(POST 只能收紧,放宽 `confirm:'LOOSEN'`)。
- Reviewer:`GET /api/reviewer/cards?limit=` → `{ cards: TradeCard[], decision, batches }`;`POST /api/reviewer/batch` → 200 `{ ran, reason, run_id }` / 409。
- Strategy Lab:`GET /api/lab/experiments?limit=` → `{ experiments: BotRun[](input=manifest, result=ExperimentResult), decision, running }`;`POST /api/lab/run` → 202。
- Gate Captain:`GET /api/captain/brief` → `{ brief: DailyBrief|null, due, briefs }`;`POST /api/captain/brief` → `{ brief }`。
- BotRun 新增 `input` / `result`(JSON);SSE 新增 `portfolio.changed`、`risk.changed`;活动 kind 新增 `risk_alert`、`risk_cleared`、`brief`。开仓执行前新增两道闸:「组合限额」「风控哨兵」。

### 9.14 对话会话与团队工具(v3.8,2026-09-06)

- `GET /api/chat/sessions?archived=1` → `{ sessions: ChatSession[] }`;`ChatSession = { id, title, created_at, updated_at, archived, can_execute, message_count, last_text }`。默认会话 id 固定 `default`(不能删,只能清空)。
- `POST /api/chat/sessions {title}` → 201 `{ session }`;`POST /api/chat/sessions/:id {title?, archived?, can_execute?}` → `{ session }`;`DELETE /api/chat/sessions/:id`。
- `GET /api/chat/messages?session=<id>&kind=chat|narration|all&limit=` → `{ messages, session }`;不传 session = 旧行为(全部)。旁白(kind narration)不属于任何会话,按 kind 拉。`POST /api/chat/messages {text, session?}`(缺省 default);`POST /api/chat/reset {session?}`。
- `ChatMessage` 新增 `session_id`。SSE `chat.message` 不变,前端按 `session_id` 归档到对应会话。
- ~~**允许执行(can_execute)**:…agent 多两个工具 approve_intent / reject_intent~~ **v3.10 作废**:模型没有批准工具,批准只能由人在界面上取一次性 confirm token 后点,见 §9.19;`can_execute` 字段保留仅作前端偏好。
- agent 新增只读工具:get_team / get_portfolio / get_risk_alerts / get_screen / get_brief / get_reviewer_cards / list_intents / ack_handoff,以及动作 run_screen / run_review_batch / run_experiment(都受各角色自己的预算与去重)。状态摘要多一行「团队:风控等级、待阅交接数、待批意图数、总敞口」。

> **数值字段可为 null(v3.7 补注,2026-09-06)**:PortfolioSnapshot 的 `positions.gross_ratio / projected.gross_ratio / by_symbol[*].gross_ratio / by_cluster[*].gross_ratio / worst_net_ratio.low|high / stop_budget_ratio` 在 `quality ≠ 'ok'`(权益 ≤ 0 或缺行情)时计算结果是 Infinity,经 JSON 序列化到前端就是 **null**;`RiskAlertRow.value / threshold`、`TradeCard.r_multiple / hold_ms / entry_price / exit_price / stop_price / realized_pnl`、`ExperimentCell.win_rate / expectancy_r` 都可能为 null。前端对这些字段先判 null 再 toFixed。

### 9.15 切执行通道 = 切账户上下文(v3.8,2026-09-06)

- `StrategyThread.backend`(paper|demo|cli|agent_mcp|mcp,旧行迁移为 paper)。`GET /api/threads` 默认只返回**当前通道**的线程,并回 `backend` 字段;`?backend=all` 看全部,`?backend=paper` 指定。`GET /api/history`、复查、对账、开放线程数都只看当前通道;别的通道的线程休眠,切回去才醒(切换本身仍要求当前通道无开放线程)。
- `AccountView.quality`:'ok' | 'unfunded'(读取成功但权益 0、无持仓);`AccountView.note` 给人看的说明(含入金链接)。读取失败不产生 AccountView:runtime 保留上一份,并在 `ExecutionView.account_read_error = { at, message }` 里报错(读成功后清空、发 `execution.changed`);`ExecutionView.account_funded`:true/false/null(还没读到过)。UI 口径:`account_read_error` 非空 → 「执行通道账户不可读」;`account_funded === false` → 「币安子账户未入金」+ 链接;两者都不是才显示权益数字。判断证据里同样会写「执行通道账户未入金…不能开新仓」而不是裸的「权益 0」。

- **会话角色(v3.8 补)**:`POST /api/chat/sessions {title?, role?}`,role ∈ 八个 BotRole;不传 title 时默认 `@角色名`。`ChatSession.role`(null = 主会话)。有 role 的会话里 agent 以该角色口径回答、优先用该角色的工具(chat.ts ROLE_PERSONA)。楼层桌子进对话 = 新建带 role 的会话再跳转,不复用旧会话。

### 9.16 观察名单 = 可交易名单 + 「只观察」标记(v3.9,2026-09-06)

- 只有一个名单:`workflow.watchlist`。上限 `workflow.watchlist_max` 现在**可调**(1–24,默认 8;每多一个币 = 多一份心跳/收盘判断的模型费,设置里要写这句)。
- `workflow.watch_only: string[]`(watchlist 的子集):标了的币判断模块只能 NO_TRADE / WATCH(judgment-graph-v3 的 `scan:watch_only` 节点,PROPOSE 不是合法边),判断照常记录;去掉标记即可交易。watchlist 变动时自动只保留仍在名单里的。
- 建议 UI:一个界面一张表,每行 币 / 「观察|交易」开关 / 最近判断 / 加入来源(手动 / Radar 提案),顶部 watchlist_max 与当前用量;Radar「应用提案」也只写这张表。
- `daily_judgment_cap`(0–5000,0 = 不限)早已可通过 POST /api/workflow 改,设置页请露出来。

- **新闻链接(v3.9 补)**:`MarketState.news[]` 每条新增 `event_id`(InformationEvent.id,稳定)与 `url`(原文链接;非 http 或非 news 事件为 null)。新快照生成即带;旧快照由网关按当轮 `info_refs` 回填(`ref` I3 = info_refs[2]),前端直接用 `url`,不要再拿 ref 去 events 里找。

### 9.17 新闻源只读列表与采集状态(v3.9,2026-09-06 中午)

- 默认五源(Jacky 拍板,**不做用户自定义源**,没有增删改接口):`coindesk` CoinDesk、`cointelegraph` Cointelegraph、`decrypt` Decrypt、`panews` PANews(中文)、`fed` 美联储新闻稿。每源最多收 10 条(媒体 6 小时内,美联储新闻稿 72 小时内,周末英文媒体常常 0 条是正常的),总量 25 条;跨源按「同链接 或 标题归一化相同」去重(先到先得,按源顺序)。`InformationEvent.source` / `MarketState.news[].source` 就是上面的 `name`。
- `GET /api/info/sources` → `{ sources: InfoSourceStatus[] }`,顺序固定:
  ```ts
  interface InfoSourceStatus {
    name: string;            // 稳定标识,= news[].source
    label: string;           // 给人看的名字
    url: string;
    lang: 'en' | 'zh';
    max_age_hours: number;                 // 收多少小时内的条目:媒体 6,美联储 72
    last_fetch_at: number | null;          // 上次尝试抓取(ms);进程启动后还没跑过信息员 → null
    last_status: 'ok' | 'error' | null;    // 同上,没跑过 → null
    last_error: string | null;             // 只有 error 时有值
    item_count: number | null;             // 上次抓到的条数(时效窗内、去重前);没跑过或失败 → null;周末英文媒体 0 属正常
    used_count: number | null;             // 上次真正进入新闻登记的条数(跨源去重 + 总量 25 之后);没跑过或失败 → null
  }
  ```
  状态是进程内的,网关重启后全部回到 null,直到下一次信息员运行(`POST /api/info/run-now` 可以立刻触发)。顶栏「过期/失败」建议口径:任一源 `last_status='error'` 显示黄;全部 error 或 `MarketState.as_of` 超过 `workflow.info_every_ms`×2 显示红。
- `MarketState.news[].source_label`(string,给人看的来源名,如 PANews):新快照生成即带,旧快照网关读出时按 `source` 回填,未知源等于 `source` 本身。前端直接用,不用自己映射。
- 采集告警仍同时出现在 `MarketState` 生成时的日志(`信息员采集告警:rss:<name>: …`),前端不用解析日志。

### 9.18 组合容量(Portfolio Manager,v3.9,2026-09-06 下午)

Jacky 的问题「多少资金进去还能放止损 / 还有几条新策略的容量」由 Portfolio Manager **纯代码**回答。它是典型止损情景下的**估算**,不是执行授权;真正开仓仍走 computeSizing + 组合限额 + 风控哨兵 + 提交前重闸。

- `GET /api/portfolio/capacity` → `{ capacity: DemoPortfolioCapacity | null, snapshot_id: string | null }`;`GET /api/portfolio/snapshot` 的响应也多了同一个 `capacity` 字段。`capacity` 为 null = 还没有账户快照或估算失败(日志 `容量估算失败`)。
- `DemoPortfolioCapacity`(契约 `packages/contracts/schema/demo_portfolio_capacity.json`,金额一律十进制字符串,算不出的字段**显式 null**):
  - `equity` / `available`: string | null;`risk_pct`: string;`leverage`: number;`default_stop_distance_pct`: string(默认 1.5);
  - `slots_total`(= workflow.max_open_threads)/ `slots_used`(开着的线程 + 外部持仓)/ `slots_free`;
  - `margin_budget`: `{ max_margin_ratio(默认 0.5 = 保证金总占用不超过权益一半), limit_usdt|null, committed_usdt|null, reserved_usdt|null, free_usdt|null, required_for_free_slots_usdt|null, slots_supported: number|null, witness_symbols: string[] }` —— `slots_supported` 是「按满风险预算 sizing,保证金预算还装得下几条」,`witness_symbols` 是它挑的币;
  - `binding_constraint`: `'thread_slots' | 'margin_budget' | 'available_margin' | 'min_size_risk' | 'rules_unknown' | 'market_unavailable' | 'watchlist' | 'snapshot_unavailable'`(当前卡在哪);
  - `by_symbol[]`: 每个 watchlist 币一行:`verdict: 'ok' | 'needs_equity' | 'rules_unknown' | 'unavailable'`、`watch_only`、`occupied`、`price|null`、`rules_source: 'exchange'|'paper'|null`、`rules_observed_at|null`、`stop_distance_pct|null`、`stop_source: 'atr'|'default'|null`、`min_qty|null`、`min_viable_notional|null`(交易所最小可下单名义)、`min_size_risk|null`(最小单的止损风险)、`required_equity|null`(要多少权益才能把它压进 risk_pct)、`equity_shortfall|null`、`margin_per_thread|null`、`risk_budget|null`、`budget_margin_per_thread|null`。
- 规则拿不到的币是 `rules_unknown`,**不会用默认 filter 冒充**;行情过期是 `unavailable`。
- 风控告警新 kind `capacity_short`(warn,scope `watchlist`):有 watchlist 币在当前权益下按 risk_pct 做不了,title 列币,detail 写每个币要多少权益。同一组币只更新金额不重复告警。
- 尺寸闸的拒单文案现在带数字:「最小下单量风险 1.20 U > 预算 0.50 U;要 240 U 权益才能按 0.5% 做 BTCUSDT」。
- 建议 UI:Portfolio 桌/团队卡显示「还能开 N 条(受 X 限制)」+ 每币一行「可做 / 要 240 U」;设置页观察名单表每行也可以放这个 verdict。

### 9.19 人批 = 一次性确认 token;对话改设置只到提议(v3.10,2026-09-06 傍晚)

背景:Codex 派单设计稿 §A/§C.3——「会话开关 + 模型一句话」不等于人批。**自动交易路径不受影响**(PROPOSE → 代码闸 → intent → 执行,从不经过这里);这里只管本来就要人点的东西。

- **模型工具里不再有 approve_intent / reject_intent**(`EXECUTE_TOOLS` 为空;模型调了返回 ok:false)。新工具 `request_execution{id}`:不下单,只推一张确认卡(activity `chat_action`,`data.intent_id` + `data.confirm:'ui'`,并重发 SSE `intent.changed`)。`ChatSession.can_execute` 字段保留,语义降为「这个会话的意图卡是否显示执行按钮」的前端偏好,后端不再据它放行任何东西;UI 文案「开了 agent 就会执行」必须删掉。
- **批准意图两步**:①`POST /api/intents/:id/confirm-token` → `{ nonce, expires_at, fingerprint, intent:{id,kind,symbol,direction,quantity,entry,limit_price|null,stop_price|null,take_profit_price|null,backend} }`(意图必须是 pending_approval,否则 409);②`POST /api/intents/:id/approve {nonce}` → 原响应。缺 nonce → **428** `confirm_required`;nonce 用过/不存在 → 409 `confirm_unknown`;超 120 秒 → 409 `confirm_expired`;意图内容在取 token 后变了 → 409 `confirm_mismatch`(重新取)。**token 一次性**。`reject` 不需要 token。建议 UI:点「执行」先取 token 并展示四项(symbol/方向/数量/止损)+ 倒计时,再点一次「确认执行」才发 approve;两次点击都在同一张卡上。
- **设置提议**(对话里 set_workflow 三档,见 confirm.ts):直接生效 narrate / info_every_ms / heartbeat_every_ms / review_every_close / scan_mode / fast_move_pct / paused=true;**只到提议** watchlist / watch_only / timeframe / playbook_text / paused=false / brain / brain_model / cheap_brain / cheap_brain_model;永远拒 风险/杠杆/上限/自动执行/执行通道/cli_commands。
  - `GET /api/workflow/proposals` → `{ proposals: WorkflowProposal[] }`(最近 50,pending 超 30 分钟自动 expired);`WorkflowProposal = { id, created_at, expires_at, status:'pending'|'applied'|'rejected'|'expired', via:'chat', session_id: string|null, patch, before, after, errors: string[], resolved_at: number|null }`,`before/after` 是 patch 各键的现值与预演值(diff 卡直接渲染这两个,别自己算)。
  - `POST /api/workflow/proposals/:id/confirm-token` → `{ nonce, expires_at, fingerprint, proposal }`;`POST /api/workflow/proposals/:id/apply {nonce}` → `{ proposal, workflow, errors }`(428/409 口径同上;提议后工作流的这些键被别人先改了 → confirm_mismatch);`POST /api/workflow/proposals/:id/reject` → `{ proposal }`。
  - SSE 新事件 `workflow.proposal { id, status, keys }`;活动流 `chat_action` 带 `data.proposal_id`。
- **需要人点的东西(建议顶栏红色计数)**= pending_approval 的 intent + pending 的 WorkflowProposal + 风控 recovery_ready 的告警 + 待批记忆。普通 PROPOSE 不是。

#### 9.19 修订(v3.10.1,2026-09-06 晚,Jacky:「他自己就能点批准,除非我设置加了要批准,不要影响自动开单」)

- 新 workflow 字段 `chat_requires_approval: boolean`(默认 **false**),`GET/POST /api/workflow` 露出;设置页放「自动化」组,文案「对话执行需我确认」。**只能人改**(对话 set_workflow 里它在 refused_keys)。与 `auto_approve`(扫描自动路径)无关,扫描路径任何情况下不经过这里。
- `chat_requires_approval=false`(默认):agent 在对话里可以 `approve_intent{id}` 直接批准并执行(仍经提交前重闸/组合限额/风控哨兵),`reject_intent{id}` 否决;意图短暂经过 pending_approval 再到 approved/filled。
- `chat_requires_approval=true`:agent 调 `approve_intent` 不下单,只推确认卡(同 request_execution:activity `chat_action` data.intent_id + confirm:'ui'),人按 §9.19 两步(confirm-token → approve {nonce})。
- 界面上的人批**始终**走 confirm token(不受开关影响);`request_execution` 保留。tooltip 改成「默认 agent 可以在对话里批准执行;开了本开关才需要你点」。`EXECUTE_TOOLS` 仍为空(不再有会话级放行)。

### 9.20 通道自验证 + 「阻断告警必须带按钮」(v3.11,2026-09-06 晚)

背景:Jacky——「这个阻断依旧在,我要是 user 不是 dev 根本处理不了」。规则:**任何阻断新增风险的告警,必须带一个用户在界面上就能点的动作;不允许出现「设环境变量 / 重启」这种只有开发者能做的指令。**

- `RiskAlert.action?: { kind: 'verify_protection'|'confirm_recovery'|'open_settings'|'switch_backend', label, method: 'POST'|'GET', path, body?, note? }`。前端在告警卡上渲染成按钮(note 放按钮旁的小字),点了按 method/path/body 调,成功后靠 SSE 刷新。没有 action 的告警只展示。
- `channel_cannot_protect` 现在带 `action = { kind:'verify_protection', label:'用最小仓验证止损', method:'POST', path:'/api/execution/verify-protection', body:{confirm:true}, note:'真钱最小仓,约 5 USDT 名义,几分钱手续费,约 2 分钟' }`。detail 文案不再提环境变量。
- `POST /api/execution/verify-protection {confirm:true, symbol?}` → 202 `{ started:true, protection }`(409 busy = 正在验证;400 = 没 confirm)。网关自己在当前通道上跑:账户读取 → 算最小仓 → 市价开最小仓 → 挂 closePosition 止损 → 交易所确认挂着 → 撤止损 → 平仓 → 确认已平;通过就落库(`demo_kv protection_verified:<backend>`)并自动放行;任一步失败会尽力撤单/平仓,状态 failed 仍阻断,告警上按钮还在。默认挑 watchlist 里第一个非 BTC/ETH 且无持仓的币。
- `GET /api/execution/protection` → `{ protection: ProtectionStatusView }`;`ExecutionView` 也多了同一个 `protection` 字段,SSE `execution.changed` 会在开始/结束时各推一次:
  ```ts
  interface ProtectionStatusView {
    status: 'not_needed' | 'verified' | 'unverified' | 'verifying' | 'failed'; // not_needed = paper/Rust/cli 后端天然会挂止损
    verified_at: number | null;      // source=record 时有
    last_run_at: number | null;
    last_error: string | null;       // failed 时有
    steps: { name: string; ok: boolean; detail: string }[];  // 最近一次验证的分步,verifying 时逐步增长
    cost_note: string;
    source: 'env' | 'record' | null; // env = 开发者覆盖(TG_AGENT_MCP_PROTECTION),不建议用
  }
  ```
- 建议 UI:执行页「币安官方 MCP」卡上放一行状态(未验证/验证中(第 n 步)/已验证 于 时间/失败:原因)+ 按钮「用最小仓验证止损」(status 为 unverified/failed 时可点,verifying 时禁用并显示当前步);顶栏那条红色风控告警的按钮同一个入口。
- 线上真挂止损失败(非「无持仓」类预期拒绝)会自动作废记录并重新阻断,告警重新出现,按钮还在。
- **同类问题排查**(只有开发者能处理的地方,本轮一并处置):①`TG_AGENT_MCP_PROTECTION` → 已改为界面按钮(env 保留为开发者覆盖);②`TG_BINANCE_MCP_HEDGE`(mcp 直连通道的双向持仓开关)→ 该通道现在被币安白名单挡着没启用,启用前要改成从 positionInformation 自动识别,记入待办;③其余 env(TG_DEMO_BRAIN/TF/WATCHLIST/AUTO_APPROVE/JUDGMENT_CAP/…)都只是**启动时的初值**,界面改过后以库里为准,不构成阻断;④风控 latch 的「确认恢复」已经是按钮;⑤对话会话/设置提议/意图批准都是界面动作。

### 9.21 Agent 辅助仓位（2026-09-07）

- `GET/PATCH /api/workflow` 新增 `sizing_agent: 'off' | 'advise' | 'apply'`，默认 `apply`：旧配置缺这个字段按 `apply`，存了认不出的值按 `advise`（只给建议、不改仓位）；写入非法值返回校验错误。UI 标签“自动仓位”，选项“关 / 只建议 / 采用”。2026-09-27 起也可以通过 `PATCH /api/execution-policy` 修改（§9.56），`POST /api/workflow {sizing_agent}` 继续可用。
- off 不调用仓位模型；advise 每次可开仓 PROPOSE 使用 `cheap_brain` / `cheap_brain_model` 调用一次，只记录；apply 采用合法意见。10 秒硬超时，无重试，失败或数字泄漏回退基准风险预算。
- `GET /api/intents` 的 `sizing.agent` 和 `GET /api/episodes/:id` 的 `sizing.agent` / `intent.sizing.agent` 为可选对象：`{ multiplier:number, overshoot:boolean, split:number, reason:string, applied:boolean }`。multiplier 0.25–2；split 1–3；reason ≤40 Unicode 字符；applied 表示是否用于代码 sizing，不代表订单通过硬闸或成交。历史记录/off 没有 agent。失败记录 multiplier=1、overshoot=false、split=1、applied=false 及回退理由。
- episode 新增可选 `sizing_evidence`，保存代码构建的 setup checklist、confidence、日线 regime/ATR%、权益、持仓和风险簇、容量行、当日 UTC 本通道平仓实现盈亏及允许控制数字。金额沿用十进制字符串。模型不得输出 qty、price、leverage 或其他额外字段；任何输出数字必须在证据数字集合中。
- 组合政策新增 `max_quote_volume_pct:number`，默认 `0.5`（百分数）。继续使用现有政策 API，放宽仍需 `confirm=LOOSEN`。单笔总名义不得超过 24h quote volume ×该值/100；无有效成交量拒绝 sizing。原 gross/net/cluster/stop-budget 和 max_notional_multiple 不变。
- overshoot 仅允许交易所最小可行手数风险 ≤调整后预算的 2 倍；其余硬上限不能被倍率或 overshoot 放宽。容量账本仍是基准预算的典型止损估计。split 仅供复盘/规划展示，本版仍发一个总量订单，不执行分批。
- 意图卡同时显示 `sizing.note` 与 agent reason，标示“已采用 / 未采用”。设计见 `docs/design/sizing-agent-2026-09-07.md`。
- 发送前对固定批准数量复查最新预算、名义/流动性、组合上限；失败拒单，不重新调用顾问、不修改已批准数量。限价候选使用 limit/mark 两个端点保守检查。

### 9.22 平仓后的交易所结算：盈亏为空 ≠ 盈亏为 0（2026-09-08）

- 缺陷：币安的下单/平仓响应里没有 `realizedPnl`，成交价也不总在回执里，所以线程平掉后 `realized_pnl` / `exit_price` 一直是 `null`，复盘的“盈亏 / 出场价”两列全空，统计把它们当 0 算进胜率与总盈亏（8 笔全 flat、win_rate 0）。三条平仓路径（复查离场 / 交易所侧平掉止损止盈 / 止损单失败补偿平仓）都没有回填这一步。
- `ExecBackend.settlement?(symbol, startMs, endMs)` 可选：返回窗口内该币的成交明细与资金费流水 `{ trades[], funding }`。`agent_mcp` 实现 = 一次 CLI 运行里两个只读工具（`futures_usds.accountTradeList` + `futures_usds.getIncomeHistory` 的 `FUNDING_FEE`），模型只原样搬运列表，**求和一律在代码侧**。返回 `null` = 这次没查到，不得当成“没有盈亏”。纸面后端不实现（回执自带盈亏）。
- 运行时：`closeThreadNow` 平仓后立即结算一次；巡检 `settlePending()` 每轮最多补 2 笔（每笔一次 CLI ≈ 20–30 s），只挑 30 天内、已平仓且 `settlement` 缺失的线程，失败按 1 min × 次数退避、上限 30 min。窗口 = `[开仓 − 120 s, 平仓 + 120 s]`，窗口内该币的成交与资金费全归这笔线程。
- `StrategyThread.settlement?: ThreadSettlement`：`{ at, realized_pnl, commission, funding, net_pnl, exit_price, trades, window, source:'exchange', note? }`。`thread.realized_pnl` 存**净额** `realized − commission + funding`（落到余额上的钱）；`exit_price` = 平仓腿的量加权均价。窗口内查不到成交时只写 `settlement.note`，`realized_pnl` 保持 `null`。
- `GET /api/history`：`stats.unsettled` = 已平仓但未结算的笔数，这些线程**不进** count / 胜率 / 总盈亏 / 最好最差 / 分组，`r_multiple` 为 null；每行新增 `settled:boolean`。UI 在盈亏、出场价两列显示“结算中”，统计卡副标题追加“结算中 n 笔”。

### 9.23 两条天天误报的 high 告警：分级与新鲜度复判（2026-09-08）

- 现象：`account_stale`「账户/行情组件过期 425 秒 / 阈值 30000」与 `protection_missing`「MUUSDT 持仓缺止损保护」反复出现，都是 high → `block_new_risk` + latch 等人「确认恢复」。查证：同期 273→290 次账户读**全部 ok**，没有一次传输错误，所以与代理（Clash）无关；代理影响的是公共行情 REST（日志里的 ECONNRESET / 8s 超时 / HTTP 429），那条另有 `transport_unstable` / `market_stale` 负责。
- `account_stale` 根因：`agent_mcp` 每次账户读要起一次 CLI（实测 13–40 s）并缓存 300 s，账户 `as_of` 天然是几百秒；`accountStalenessMs()` 原为 `ttl + timeout = 420 s`，而真实上界还要加轮询间隔（15 s）、`pollAccount` 单飞排队、巡检里夹着的其它 CLI，实测 425 s 就越线。修复：`accountStalenessMs()` 加 90 s 余量（`STALENESS_SLACK_MS`）；`evaluateRisk` 收 `account_max_age_ms`，过期在上界 1–2 倍之间只报 **warn**（不阻断、不 latch），超过 2 倍才 high。
- `protection_missing` 根因：止损/止盈成交那一瞬，交易所已经既无条件单也无持仓，而本地快照最老是几分钟前的——用旧快照判「有持仓、没止损」必然误报。09-08 00:00 MU 那条 high 就是这样来的，00:02 新快照才认出仓位已被止损平掉（结算 −0.2525）。修复：`evaluateRisk` 收 `account_age_ms`，快照 > `PROTECTION_FRESH_MS`（90 s）时该告警降为 **warn** 并说明正在复判；同时 runtime 在这种情况下 `invalidateAccount()` + 强制重读账户（冷却 120 s），用新鲜事实复判——真裸奔会在一次重读后升级为 high，指纹不变所以不会新建告警。
- 不变的部分：真读不到账户、真裸奔仍然是 high 并阻断新增风险；`ExecBackend` 新增可选 `invalidateAccount?()`。

### 9.24 丢了回执的意图会把开仓闸永久锁死（2026-09-08）

- 现象：`execution_unknown`「1 笔订单状态不明」持续 high，gates 每次开仓提议都拒「有一笔订单状态不明，先核对再开新仓」，锁了 16 小时。查证：那笔 KORUUSDT 09-08 08:19 的入场单在交易所 `allOrders` 里**一条记录都没有**（请求没到交易所），08:30 线程因论点失效被撤掉，意图却永远停在 `unknown`。
- 根因：`cancelEntry()` 撤单被证实后把线程标 `canceled`，但没有像 reconcile 的 canceled 分支那样调 `resolveOpenIntents()`；没有活线程再去核对这笔意图，而 gates 只数 unknown 意图的笔数。
- 修复：`cancelEntry()` 成功分支收敛意图为 `failed`；另加一条纯本地兜底 `resolveOrphanIntents()`（每轮巡检跑一次，不调交易所）：意图停在 `unknown`/`approved`、其线程已终态（canceled / invalidated / closed）时，按线程收敛——`open` 且线程有成交价记 `filled`，否则 `failed`，并写一条 warn 日志留痕。线程还是 `pending_entry`/`in_position` 时不动它：那时的 unknown 是「还没核对出结果」，不是失败。

### 9.25 策略议会：多条策略各自表态，共识才交易（2026-09-09）

设计与边界见 `docs/design/strategy-council-2026-09-09.md`。策略层从「prompt 里的几段文字」变成循环里独立的一步：每条策略先各自对这个资产表态，代码算共识，共识进证据；开仓时把票面快照钉进线程，复查时复核「当初同意的现在还同不同意」。

- **三个开关**（`GET/POST /api/workflow`，随 `Workflow` 一起出入，只有人能改；对话里改属于「提议」档）：`strategy_council`: `'off' | 'advise' | 'require'`（默认 `advise`）、`council_min_agree`: 1–4（默认 2）、`council_model`: `'off' | 'cheap' | 'main'`（默认 `off`，开了每条被唤醒的策略多一次模型调用）。
- **`Episode.strategy_council`**（`off` 模式缺省，可为 null）：`{ version, at, symbol, mode, verdicts[], consensus, text }`。
  - `verdicts[]` 每项：`{ strategy_id, version, content_hash, horizon, stance: 'long'|'short'|'neutral'|'abstain', confidence: 0–1, source: 'code'|'model'|'code+model', fit: { score: number|null, parts: { radar, lab, eval, history }（**四个都可为 null**）, note }, checks: [{ id, pass: boolean|**null**, note }], reasons[], at }`。
  - `consensus`：`{ reached, direction: 'long'|'short'|**null**, agreeing[], dissenting[], neutral[], abstaining[], required, reason }`。`required` 是钳过之后真正生效的票数门槛。
  - `text` 是进 prompt 的那一行代码汇总，UI 可以直接显示。
- **`StrategyThread.council`**（可为 null；旧线程没有）：开仓那一刻的快照 `{ version, at, direction, reached, agreeing[], dissenting[], votes: [{ strategy_id, version, stance, confidence, fit: number|**null** }] }`。
- **闸**：`episode.gates` 里多一条 `{ name: '策略共识', passed, reason }`。`advise`/`off` 模式下它**永远 passed**（照常记录，便于事后统计「开了 require 会拦掉多少」）；`require` 模式下无共识 / 方向不符 / `strategy_id` 不在同意方 → `passed:false`，提议被拦。判断图 `judgment-graph-v3` 的 `scan.PROPOSE` 边多一个守卫 id `strategy_consensus`。
- **弃权不是反对**:`abstain` = 这次触发器没唤醒它、这条策略还没有代码裁决实现、或者关键判据算不出来。弃权不计票;**09-12 起 `min_agree` 不再被钳到「能投票的策略数」**,见下面的补正三。
- UI 建议：判断记录详情加一块「策略议会」（共识一行 + 每票一行，弃权灰显）；线程/持仓详情显示开仓票面与最新复核；设置页把三个开关放在策略库那一组。

补正（同日晚些，对抗复核后）：

- ~~**前端必须显示 `consensus.required` 而不是用户设的 `council_min_agree`**:能投票的策略少于设定值时 `required` 会被静默钳降~~ —— **09-12 作废**:钳降已删,`required` 现在**就是**用户设的 `council_min_agree`(见补正三)。
- ~~**`council_model` 开着时,共识可以部分由模型票构成**~~ —— **09-12 作废**:模型票不再能补出任何一票,只能减权(见补正三)。
- 议会的模型票**计入该 episode 的 `usage`**（并行、每条 30 秒超时、每次最多 4 条）；`daily_judgment_cap` 数的仍是 episode 数，不数议会调用。
- 复查 episode 也带 `strategy_council`，但票池被刻意缩小成「开仓时同意的那几条 + 线程钉住的策略」，不是当前全部启用策略；复查的结构化结果在 `Episode.council_review`（`{ still_agree[], flipped[], gone_neutral[], text }`，可为 null）。

补正三(2026-09-12,按 `.codex-reports/council-entry-review.md` §B4/§B7/§D 修):

- **共识闸改 fail closed,钳降删除**。`consensus` 新增字段:
  - `required`:**用户设的 `council_min_agree` 原样**(不再钳到「能投票的策略数」);前端显示它就是真门槛。
  - `voting: string[]`:这次真正能投票(非弃权)的策略 id。
  - `gate_effective: boolean` + `gate_reason: string`:能投票的策略撑不起 `required` 时 `gate_effective=false`、`reached=false`,`gate_reason` 给可读原因(例:「共识闸当前无效:能投票的策略只有 1 条(breakout_retest),不足门槛 2 条;弃权:range_mean_reversion」)。**前端在 `gate_effective=false` 时要显示「共识闸当前无效」,而不是普通的「无共识」**——这两件事含义不同:前者是「这条闸这次根本没生效」。
  - `require` 模式额外要求至少 **2 条**策略能投票(`REQUIRE_MIN_VOTERS`):一条策略自己投票不叫「多条策略一致」。真只想要一票的人得显式设 `council_min_agree=1` 并接受 advise 语义。
  - `require` 模式下 `gate_effective=false` → 「策略共识」闸 `passed:false`,提议被拦,理由就是 `gate_reason`。
  - 旧行为的危险:两条策略里一条因**数据缺**弃权,门槛就自动从 2 降到 1,剩下那条自己放行——数据越少反而越容易开仓。
- **模型票只能减权,不能增权**(`mergeVerdict`):
  - 代码**任何**原因弃权(`data` / `unimplemented` / `not_woken`)→ 模型票只进 `reasons`,**不成票**(以前 `unimplemented` 会直接采用模型票)。
  - 代码中立(含硬条件失败)→ 模型的方向票**不能**把它翻成可执行票(以前 `0.9 × 0.7 = 0.63` 就越过 0.4 阈值)。
  - 代码有方向 → 模型反向 = 中立;模型中立/弃权 = 信心打七折;模型同向 = 取均值且**不超过代码票**。
  - 所以 `require` + `council_model` 现在确实是「代码闸 + 模型只做减权」。
- **Radar 候选不再替换票池**:候选策略只作为「优先/提示」(排最前、决定扫描周期),票池始终是 `active_strategies` 全集 ∪ 候选。以前候选一出现票池就只剩它一条,「多条策略一致才交易」直接失效。
- **策略自己声明取数深度**:`StrategySpec.checklist.min_bars`(可选,**不进 `content_hash`**)。扫描/议会拉主周期 K 线的根数 = 启用策略的 `max(min_bars)` + 5 根余量(还在走的那根会被切掉),都没声明时仍是 60。`range_mean_reversion` 声明 400;真的不够时它的票面写「数据不足 N/400」而不是静默弃权。老库里的 v1 行由 `seed()` 的结构补齐补上这个字段。
- **关键判据算不出来一律 `abstain`(`abstain_reason='data'`)**,不再混进中立票:突破族缺 ATR%、多周期缺 EMA20 位置、压缩→扩张缺量比、资金费率缺 OI 1h、均值回归缺 ATR 或不足 400 根。

### 9.25b 方向成立 ≠ 入场时机已确认(2026-09-12)

Jacky 拍板:议会的策略表态只回答**方向是否成立**(突破有效 / 多周期同向 / 极值成立…),「回踩确认」是**另一个**裁决。以前「趋势同向但回踩没确认」被算成中立票,于是策略原文明明允许的「未确认时挂限价等回踩」被议会自己挡掉了。

- `StrategyVerdict.entry_timing`: `'confirmed' | 'pending' | 'failed' | null`(弃权时 null)。
  - `confirmed` = 时机已确认,市价可用(仍受 §9.26 的 1 ATR 追单闸);
  - `pending` = 方向成立、时机未确认,**只许限价挂回踩区**;
  - `failed` = 时机判据坏了(不是「还没到」),不投方向票。
- `Consensus.entry_timing`:同意方里**最保守**的那个(任一条 `pending` → 整体 `pending`)。
- **闸**:`require` 模式下共识 `entry_timing='pending'` + `proposal.entry='market'` → 「策略共识」闸拒,理由写「只许限价挂回踩区」;`entry='limit'` 放行。所以「方向成立 + 时机 pending」现在**允许 PROPOSE**,入场方式走 §9.26 的 `prefer_limit` 路径。
- 已按这套口径接线:突破族(回踩未确认且 `watch_eligible` → 方向票 + `pending`,信心 0.45)、`funding_oi_extreme` 的 follow 分支(原文就写「只许顺势限价挂回踩」→ `pending`)、`vol_compression_expansion`(压缩了还没扩张 → 中立 + `pending`)、`range_mean_reversion`(偏离够深即 `confirmed`)。
- `EpisodeSummary.council` 与线程快照 `StrategyThread.council` 也带 `gate_effective` / `entry_timing`(旧快照没有这两个字段 → `undefined`)。

**09-12 补(P1-05 / P1-07 / `limit_only`)**

- **总决策只减不增**:`CouncilResult` 多一个 `code_consensus`(纯代码票算出的共识 = 允许集上界)。最终 `consensus` = `narrowByCode(code_consensus, 合并模型票后的共识)`,闸有效性 / 是否达成 / 方向 / 同意方集合 / `entry_timing` 五维**只能收窄**:模型压低某张票不能解除代码层的方向冲突,也不能把整体时机从 `pending` 洗成 `confirmed`。旧快照没有 `code_consensus` → `undefined`。
- **`entry='limit'` 这个枚举值不再等于「在等回踩」**:`classifyEntryOrder()` 把入场单分成 `market` / `marketable_limit`(做多挂在现价之上,会立刻成交)/ `waiting_limit` / `unknown_limit`。`entry_timing='pending'` 时 `marketable_limit` 与市价同等被拒;发送前的 `finalEntryCheck()` 按**最终策略/方向 + 冻结突破位 + 新鲜可执行价(≤30s)**重测距,测距不过的等待型限价给 `waiting_limit_too_far`、立刻成交的给 `chase_too_far`,身份证明不了(没限价 / 价格不新鲜)在 `pending` 下 fail closed。`EntryStyleAdvice` 因此多带 `mark` / `breakout_level` / `atr` / `entry_mode`。
- **`workflow.entry_style` 加第三档 `limit_only`**:`'free' | 'prefer_limit' | 'limit_only'`,**默认仍是 `prefer_limit`**。`limit_only` = PROPOSE 带市价一律拒(不看追单距离,理由写明),唯一豁免是这条策略的 `rules.entry_mode === 'market_ok'`(`StrategySpec.rules` 新增的可选字段,**不进 `content_hash`**,给老版本补它不会造出新版本)。限价路径完全沿用现有的 tick 对齐 / 挂单耐心 / 撤单链,这一档只管「市价能不能用」。


### 9.26 限价入场与挂单耐心（2026-09-09）

设计见 `docs/design/limit-entry-and-patience-2026-09-09.md`。以前几乎全是市价入场，因为「回踩确认才市价」这条策略规则只写在 prompt 文本里、没有任何代码算过它。

- **两个开关**（`Workflow`，随 `/api/workflow` 一起出入，只有人能改）：`entry_style`: `'free' | 'prefer_limit'`（默认 `prefer_limit`）、`entry_max_wait_bars`: 2–48（默认 8）。
- **`Episode.entry_advice`**（扫描时有，复查为 null）：`{ recommended: 'market'|'limit', zone: [低,高]|**null**, dist_to_break_atr: number|**null**, retest_confirmed, market_blocked, reason, text }`。`zone` 是参考挂单区，永远落在现价的不利侧。
- **`Episode.pending_entry`**（只有「已挂在交易所的限价单」复查时有，其余为 null）：`{ bars_waited, minutes_waited, max_wait_bars, in_zone, dist_to_zone_atr: number|**null**, ran_away, structure_gone: boolean|**null**, volume_dry: boolean|**null**, cancel_warranted, reasons[], text }`。市价单停在 `pending_entry`（只拿到 ACK 还没查到成交）与调用在途时**不出**这块——那是查单的问题，不是撤单的问题。
- **闸**：`episode.gates` 多一条 `{ name: '入场方式', passed, reason }`，判断图守卫 id `entry_style`。它只拒**距突破位 > 1 ATR 的市价开仓**；距离算不出来、限价单、`free` 模式一律放行。闸不改价格。
- **限价对齐**：`limit_price` 在建线程最前面按交易所 `tick_size` 对齐（做多向下取、做空向上取），**数量计算 / 组合闸 / 持仓计划 / 审批 / 发送用的都是对齐后的价**；只有 `executeEpisode` 里建线程之前那次 `evaluateGates` 仍用模型原价（差 < 1 tick）。对齐发生时日志留一条 info。所以线程上的 `entry.price` 可能与 `judgment.proposal.limit_price` 差一个 tick，这是刻意的，不是不一致。**2026-09-12 起对齐改成十进制定点(BigInt,按 price/tick 小数位缩放)**:极端价(`1234567890.1` / tick `0.1`)与极小 tick(`1e-8`)都不会再退错一格;非法输入或对齐后 ≤ 0 时原样返回,由价格闸 / 交易所 filter 处理。
- **每日判断预算 `daily_judgment_cap` 出队执行前会再查一次**(2026-09-12):入队时查一次不够——60 币批量入队时预算还没花完,排到自己时可能早已超额(串行队列只去重、不预占预算)。超了就丢弃这次任务并写一条 warn 日志,不调模型。
- **挂单的 `INVALIDATE` 现在是常开的边**，两个例外只给 HOLD：行情快照过期、以及没有持仓计划的旧线程。入场调用还在发送中时 `cancelEntry` 一律不撤、保持 pending 等回执。撤单不改任何已批准的经济字段；但**撤单请求成功不等于这单没成交**（撤后还没有回查成交量，这条竞态未修，上真钱前先修），且**撤单不退当日开仓计数**，UI 上要提示用户这两点。
- 挂单复查**最早**一小时一次（不跟 horizon 的 4h/24h）——这是「资格」不是「保障」，实际仍要等 K 线收盘或事件唤醒并排队。价格进入入场区附近或越过 1 ATR 会生成一条 `position_review` 唤醒理由。

**列表/时间线摘要（§9.25/§9.26 的补充）**：`EpisodeSummary`（`GET /api/episodes`、`/api/overview.recent_episodes`、SSE `episode.finished`）新增两个字段，不用逐条拉详情：

- `council`: `{ reached, direction: 'long'|'short'|**null**, agreeing: number, required: number, abstaining: number, gate_effective: boolean, entry_timing: 'confirmed'|'pending'|'failed'|**null** }`,议会关闭时为 **null**。`required` 是用户设的门槛原样(09-12 起不再钳降);`gate_effective=false` 时列表上应标「共识闸无效」。
- `entry`: `{ recommended: 'market'|'limit', market_blocked: boolean }`，非扫描 episode 为 **null**。

### 9.29 判断准确度账本 judgment_ledger（2026-09-12）

设计见 `docs/design/strategy-loop-v2-and-events-2026-09-12.md` §3。复盘以前只有「这笔赚没赚」，分不清是**策略不行**还是**模型判断不行**。账本把同一时刻的三个方向放在**同一个 horizon、同一批 K 线**上各结算一次 R：模型 / 议会 / 机械基线。差值就是模型的增量。**全部代码算，零模型成本**（付费 eval 只在改 prompt 时跑）。

**它是方向性证据，不是 P&L**：单路径、不再入场、不分批、无手续费与滑点（模型腿在有线程且已结算时例外，那条用交易所净 R）。能回答「模型比议会强不强」，不能回答「这条策略赚不赚钱」。

**口径**

- 机械基线 = eval-a 那枚硬币：1h EMA20 vs EMA50 定方向、突破位外 **0.8 ATR** 止损、**1.5R** 目标、最多 **48 根**判断周期 K 线，都没碰到按第 48 根收盘 mark-to-market。同一根同时触及止损与止盈按**止损**计（fail-pessimistic），跳空穿越按开盘价出。
- 议会腿 / 模型腿用**同一套风控参数**，只换方向（做多用 20 根高点、做空用 20 根低点做突破位）。
- **不表态 = 0R 的 flat 腿**：模型 `NO_TRADE` / `WATCH` / `EXIT` / `INVALIDATE`，或议会没有共识。那是一个真实的决定，它的对照面正是另一条腿在同一段行情里拿到的 R。
- **NULL 不是 0**：方向说不出来、horizon 内取不到 K 线、止损落在成交价错误一侧 → 留 `null`，不进任何均值。
- 指标快照从 episode 的**代码生成**的结构证据里回读，所以带着证据行的显示舍入（价格 > 100 时取整）。三条腿吃同一份快照，比较不受影响；**不要拿它当成交价**。

**`GET /api/judgment-ledger?since=&strategy_id=&limit=&offset=`** → `{ rows: JudgmentLedgerRow[], total, limit, offset, since: number|**null**, strategy_id: string|**null** }`，新的在前，`limit` 上限 500。

`JudgmentLedgerRow`（可为 null 的字段已标出）：

- `version`、`episode_id`、`at`、`as_of`、`symbol`、`mode: 'scan'|'review'`。
- `timeframe: string|**null**` —— 判断周期（反事实走它的 K 线）；没有结构证据时为 null，该行永远结算不出 R。
- `thread_id: string|**null**`、`strategy_id: string|**null**`（模型自称的，退回线程钉住的；都没有为 null）。
- `model_action: string|**null**`（判断没跑出来时）、`model_dir: 'long'|'short'|**null**`（**null = 不表态**；复查时 HOLD/ADD/REDUCE 取线程方向，EXIT/INVALIDATE 不表态）。
- `council_dir: 'long'|'short'|**null**`、`council_agree: boolean|**null**`（**null = 这次没有议会**，不是「没达成共识」；false 才是没达成）。
- `mechanical_dir: 'long'|'short'|**null**`、`mechanical_note: string|**null**`（`mechanical_dir` 为 null 时写为什么）。
- `horizon_end_at` —— `as_of + 48 × 周期`；巡检按它判断能不能结算。
- `outcome_r_model / outcome_r_council / outcome_r_mechanical: number|**null**` —— **落行时全是 null**，结算是异步的。
- `outcome_source_model: 'thread_settlement'|'counterfactual'|'flat'|'unscoreable'|**null**`（null = 还没结算）。`thread_settlement` = 交易所净 R（含手续费与资金费）。
- `regret_review: number|**null**` —— 复查 HOLD/EXIT 的反事实 R 差（`best − chosen`，按构造 ≥ 0）；非复查、线程已终态、或算不出时为 null。
- `settled_at: number|**null**`（**null = 还没结算**）、`settle_note: string|**null**`。
- `snapshot: LedgerSnapshot|**null**`、`review: LedgerReviewSnapshot|**null**`、`regret: LedgerRegret|**null**`、`legs: { model|**null**, council|**null**, mechanical|**null** }` —— 明细，给详情抽屉用；每条腿是 `{ direction: 'long'|'short'|**null**, r: number|**null**, status: 'stop'|'tp'|'expired'|'flat'|'unscoreable', fill|**null**, stop|**null**, tp|**null**, bars_walked, note }`。

**`GET /api/judgment-ledger/summary?since=`** → `LedgerSummary`：`{ version, since: number|**null**, n, settled, unsettled, overall: LedgerStratum, by_strategy: LedgerStratum[], min_sample: 10, conclusion: string }`。`conclusion` 是写死在代码里的结论口径字符串，UI 直接显示，不让模型改写。汇总一次最多读 500 行，窗口更大时用 `since` 收窄。

`LedgerStratum`：

- `strategy_id: string|**null**`（null = 全体那一层；分层里没指明策略的归到 `'(未指明策略)'`）、`n`、`insufficient: boolean`（`n < 10`）。
- `judgment_alpha: number|**null**` = `mean(R_model − R_council)`，`alpha_n` 是真正进均值的行数（两条腿都有 R）。
- `alpha_vs_mechanical: number|**null**` = `mean(R_model − R_mechanical)`，`alpha_mech_n` 同理。
- `override_rate: number|**null**` = 模型方向与议会方向不一致的比例；分母只数**已结算且这次有议会**的行（`override_n` 是分子）。
- `override_alpha: number|**null**` = 不一致时的 `mean(R_model − R_council)`。
- `review_regret: number|**null**` = 复查 regret 均值（越小越好），`review_n` 是样本数。
- `verdict: 'insufficient'|'no_edge'|'model_adds'|'model_hurts'|'unclear'`。

**结论口径**（代码判，`LEDGER_CONCLUSION`）：`judgment_alpha ≈ 0`（|alpha| ≤ 0.05）**且** `override_alpha < 0` → `no_edge` = **模型没有增量，该关掉模型让议会直接下单（省钱）**；`judgment_alpha > 0.1` → `model_adds`，只在某族为正就只在该族用模型；`< −0.1` → `model_hurts`。任何一层 `n < 10` → `insufficient`，数字照算但**不下结论**。`alpha_vs_mechanical ≤ 0` = 连那枚硬币都没赢，先别谈策略好坏。

**复盘批次卡**：Reviewer 的 `review_batch` `bot_run.result` 里多一个 `judgment_ledger: LedgerSummary|**null**`（近 30 天），`summary` 一行尾巴带上 `判断增量 xR(verdict)`。**这份汇总是代码算的，不进模型 prompt** —— 模型不该看着自己的成绩单去写教训。

**UI 建议**：复盘页一张表（每策略一行：n / judgment_alpha / alpha_vs_mechanical / override_rate / override_alpha / review_regret / verdict），`insufficient` 的行整行灰显并标「样本不足」；`null` 一律显示「—」而不是 0；行点开是三条腿的明细（方向、成交/止损/止盈、走了几根、怎么结束的）。

### 9.30 事件区(Event Zone,2026-09-12)

设计见 `docs/design/strategy-loop-v2-and-events-2026-09-12.md` §5。以前事件只存在于信息员的一段新闻摘要里,看完就没了;现在它是**有生命周期的实体**,窗口内进证据、窗口后由代码回填 impact、同类聚合成历史先验。**事件永远不直接下单**——它只做三件事:进证据、给触发器一个 `event` 种类、以及 `event_blackout` 闸(拒开仓,不拒平仓)。

**路径是 `/api/market-events`,不是 `/api/events`。** `GET /api/events` 早就是 SSE 事件流(浏览器订阅 `loop.state` / `episode.*` 的长连接),不能被占。前端接事件区时别按设计稿里的字面路径写。

#### 实体 `MarketEvent`

`GET /api/market-events` / `GET /api/market-events/:id` 返回的每条事件(snake_case,时间戳一律 **unix 毫秒**):

| 字段 | 说明 |
|---|---|
| `id` | `ev-<dedupe_key 的 sha256 前 16>` |
| `kind` | `scheduled` / `news` / `exchange` / `onchain` / `derived` |
| `subkind` | `fomc` `cpi` `nfp` `unlock` `listing` `delisting` `hack` `etf_flow` `regulation` `upgrade` `funding_extreme` `vol_spike` `unclassified` |
| `assets` | `string[]`;**空数组 = 宏观事件**(对每个币都相关)。基础资产,不带 `USDT` 后缀 |
| `expected_at` | `number` \| **null** —— 只有 `scheduled` 有;其余为 null,窗口从 `captured_at` 起算 |
| `window_ms` | 影响窗口长度(按 subkind 给默认:宏观数据 2–4h,解锁/上币 12–24h) |
| `captured_at` / `updated_at` | 抓到 / 最后改动 |
| `source` / `source_ref` | `calendar` / `triggers` / `manual` / RSS 源名;`source_ref` 可能是**空字符串**(手动补录不填时) |
| `confidence` | `confirmed` / `reported` / `rumor` |
| `status` | `captured` / `briefed` / `live` / `resolved` / `retro_done` / `dismissed` |
| `brief` | `{ at, text, refs[], lead_minutes: number\|**null** }` \| **null** —— 最近一份简报;没出过为 null |
| `briefs` | 简报历史(最多 2 份:T−60m / T−10m);`brief` 是它的最后一条 |
| `brief_count` | 已经为这条事件调过几次便宜大脑,**硬上限 2** |
| `impact` | `{ move_1h_pct, move_4h_pct, move_24h_pct, realized_vol_ratio, symbol, base_price, computed_at }` \| **null**;**里面前四个数每一个都可能单独是 null**(K 线还没到那么远就是 null,不编) |
| `used_by` | 引用过这条事件的 episode id(最多留最近 50 条) |
| `title` | 已 sanitize 的标题(外部文本,前端仍按不可信内容渲染) |
| `dedupe_key` | 去重键,同键只有一行 |
| `resolved_at` / `dismissed_at` | `number` \| **null** |

列表/详情里每条还额外带三个**派生字段**(前端不用自己算窗口):`starts_at`(= `expected_at ?? captured_at`)、`ends_at`(= `starts_at + window_ms`)、`in_window`(bool)、`minutes_to_start`(已开始为负数)。

#### 生命周期

`captured → briefed → live → resolved → retro_done`,**只往前走**,外加任意非终态可 → `dismissed`(人工判定「这不算事件」)。`retro_done` 与 `dismissed` 是终态。前端不要画成可回退的流程。

- **capture 三路**:①信息员抓到的新闻按**关键词表**分类(零模型;分不出来记 `unclassified`,不叫模型);②日历(FOMC/CPI/NFP 静态表 + 可配置 RSS/JSON 订阅源,**订阅源默认空**,不硬编第三方);③派生(triggers 的 `funding` / `vol_spike` 升格,同资产同 subkind 在一个窗口内只一条)。
- **brief**:`scheduled` 事件在 T−60m / T−10m 各叫一次便宜大脑出 ≤200 字简报,**每事件最多 2 次**;`paused` 时一次都不叫;模型失败写一条代码兜底简报(也算一次,防止每分钟重试)。简报 token **不进 `usage_today`**(那个数的是 episode),单独出在 `brief_usage_today`。
- **live**:窗口内。该资产的判断会多一条 `kind:'event'` 的触发器,证据里多一条 `事件·<subkind>` (带简报与同类历史)。
- **resolve → retro**:窗口结束后代码拉 1h K 线回填 impact(基准 = 事件时刻**之前**最后一根收盘价;宏观事件用 `BTCUSDT` 代表大盘)。24h 那一档要等够 24 小时才算得出来,算不出来就停在 `resolved`,下一拍再补;齐了才 `retro_done`。

#### 历史统计 `EventStats`

列表接口的 `stats` 是 `subkind → EventStats` 的字典(只含列表里出现过的 subkind),详情接口的 `stats` 是这一条的 subkind:

`{ subkind, samples, avg_abs_move_4h_pct: number|**null**, avg_move_4h_pct: number|**null**, direction_agreement: number|**null**, dominant_direction: 'up'|'down'|**null** }`

- 只数 `resolved` / `retro_done` 且 `impact.move_4h_pct` 不为 null 的行;`dismissed` 的排除。
- `samples = 0` 时后四个字段**全是 null**,UI 要写「样本不足」而不是显示 0——0 会被读成「平均波动 0%」。
- `direction_agreement` 是占多数那个方向的占比(0.5–1),样本 < 2 为 null;完全对半时 `dominant_direction` 为 null。

#### 闸 `event_blackout`

- **`Workflow.event_blackout_min`**(随 `/api/workflow` 一起出入,只有人能改):整数 0–360,**默认 0 = 关闭**。越界/非整数是**报错**不是静默钳。
- `> 0` 时:从事件 `starts_at − N 分钟` 起、**一直到 `ends_at`**(窗口结束)为止,这个币不开新仓。注意是「封锁期 + 整个影响窗口」,不只是事件前 N 分钟。
- **只拦开仓**(`PROPOSE` / `ADD`)。平仓、减仓、撤单永远 `passed`,理由写的是「只拦开仓」——事件封锁不能把人困在仓位里。
- 表现为 `episode.gates` 里多一条 `{ name: '事件封锁', passed, reason }`。关闭时这条**照常出现**且永远 passed(便于事后统计「开了会拦掉多少」)。

#### 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/market-events?status=&asset=&subkind=&since=&limit=` | 列表。`status` 非法 → 400 `bad_status`;`since` 非数字 → 400 `bad_since`。`asset` 可给 `BTC` 或 `BTCUSDT`,**宏观事件(`assets` 为空)在按资产筛时也会返回**。`since` 比的是 `ends_at`。默认 100 条,上限 500 |
| GET | `/api/market-events/:id` | 详情 + 该 subkind 的 `stats`;未知 id → 404 `not_found` |
| POST | `/api/market-events` | 手动补录。`title` 必填;`subkind` 留空 → `unclassified`(**刻意不跑分类器**:人填了就以人填的为准);`expected_at` 留空 → `kind:'news'`、窗口从现在起算;`source: 'manual'`、`confidence` 默认 `confirmed`。新建 **201**,命中去重 **200 + `created:false`** |
| POST | `/api/market-events/:id/dismiss` | 标记不算事件,幂等;未知 id → 404 |

列表接口另外返回:`as_of`、`calendar`(`{ last_verified_at, entries, feeds }` —— 静态日历表最后照官网核对的时间,`feeds` 是已配置的订阅源数,默认 0)、`event_blackout_min`、`brief_usage_today`(`{ calls, input_tokens, output_tokens }`)、`subkinds`(分类器认得的全集,给筛选下拉用)。

**没做(下一包)**:前端 `#/events` 页;事件驱动的策略族 `event_driven`(设计 §5.2 第 5 点,要走策略晋升阶梯);事件 `lab_stats`。

### 9.31 保护腿凭证:有期限,按「通道 × 交易对」(2026-09-12)

背景(Codex 复审):v3.11 的 `protection_verified:<backend>` 是**声明**不是**证明**——一次性标记、没有效期,一个月前验过的通道和昨天验过的在闸眼里一样;而且「从来没验证过」和「验过但最近一次真挂止损失败」是同一个处理(都降成 warn 不挡开仓)。现在它是一张**有期限的凭证**,按通道 × 交易对存。

- **凭证**(demo_kv 一行 `protection_credentials`,JSON 数组):`{ channel, symbol: string|null, verified_at, expires_at, last_probe_at, last_probe_ok, last_error, last_auto_at }`。`symbol=null` 是 v3.11 迁移来的**通道级兜底**凭证,给还没有自己凭证的交易对用。判定用的过期时刻按**当前** `protection_ttl_days` 从 `verified_at` 现算(把 ttl 改小,旧凭证立刻过期)。
- **新 workflow 字段** `protection_ttl_days`(整数 1–30,默认 **7**,`GET/POST /api/workflow` 一起出入)。只有人能改:对话里的 `set_workflow` 把它归到拒绝档。
- **三态闸**(每个通道 × 交易对各判各的):
  - `never_verified`(这个币在这条通道上从没验过)→ **阻断**它的新开仓(提交前重闸 `preflightOpen` 里那条:「…从没验证过能挂止损」)。**只挡这个币**,已验证的币照常开。告警 `protection_never_verified`(**high**,scope = 交易对,带 `action`「用最小仓验证止损」,body 带 `symbol`);它的 `auto_action` 显式是 `none`——阻断已经按币做了,不该再用全局 latch 把别的币也锁死。
  - `verified_stale_or_probe_failed`(凭证过期,或最近一次真挂止损失败如 -4130)→ **warn 不挡**,由巡检自动重跑金丝雀续期。告警 `protection_stale`(warn,scope = 交易对,带 `action`「重新验证止损」)。
  - `verified` → 放行。
  - 另有两个非判定态:`not_needed`(paper / Rust / cli 后端天然会挂止损)、`verifying`(金丝雀正在跑)。
- **自动重跑金丝雀**:巡检每轮最多跑一个,**每通道 × 交易对每天最多一次**(`last_auto_at` 落库,重启不重置)。紧急停止 / 暂停 / 没有账户快照 / 账户没资金 / 这个币上有活线程时不跑,原因写进 `auto_note`(界面与告警 detail 里都看得到)。成功续期;失败留在第二态并记 `last_error`。**从没验过的币不会自动跑**:第一次花真钱必须是人点的。
- **线上真挂止损的事实会落到凭证上**:失败(非「无持仓」这类预期拒绝)只把**这个币**标 `last_probe_ok=false` 降到第二态,不再像 v3.11 那样作废整条通道;成功挂上则顺手续期(比金丝雀更硬的证据,省一次真钱)。
- `GET /api/execution/protection` → `{ protection: ProtectionStatusView }`(`ExecutionView.protection`、SSE `execution.changed` 同一形状)。`ProtectionStatusView` 在 §9.20 基础上多:
  ```ts
  state: 'not_needed' | 'verifying' | 'verified' | 'verified_stale_or_probe_failed' | 'never_verified'; // 通道汇总:取**最好**的那条凭证
  ttl_days: number;            // 当前生效的有效期(天)
  expires_at: number | null;   // 汇总凭证的过期时刻(按当前 ttl 现算)
  auto_note: string | null;    // 自动重验这轮为什么没跑
  credentials: {               // watchlist 每个币一行(没有凭证的也在,state=never_verified)+ 库里其它已有凭证
    channel; symbol: string|null; state; verified_at; expires_at; last_probe_at; last_probe_ok; last_error; last_auto_at;
    source: 'symbol' | 'channel' | null;   // 这个币自己的凭证 / 通道级兜底 / 没有
  }[];
  ```
  旧字段 `status` 保留给还没改的前端(`never_verified`→`unverified`,probe 失败→`failed`);**新前端请看 `state` 与 `credentials`**,阻断是按 `credentials[].state` 判的,不是看汇总。
- `POST /api/execution/verify-protection {confirm:true, symbol?}` 不变,但通过后落的是**这个交易对**的凭证,并只解除这个币的两条保护腿告警(v3.11 遗留的 `channel_cannot_protect` 一并关掉)。
- **兼容**:现网 demo_kv 里的 `protection_verified:agent_mcp` 首次读到时迁成「通道级、无 symbol、`verified_at` = 当初写入时间」的凭证,按当前 ttl 算过期(一个月前验的读出来就是第二态,正是这次要修的东西),旧键随即置空,只迁一次。
- **建议 UI**:执行页保护腿卡从一行状态变成一张小表——每个币一行「状态 / 验证于 / 过期于 / 上次真挂结果」+ 这一行的「验证」按钮;顶部一行汇总与 `auto_note`;设置页「自动化」组加 `protection_ttl_days`(1–30 天,默认 7,文案「止损验证凭证多久要重验一次」)。

### 9.27 策略闭环 v2：生命周期台账 + 影子实盘 + 自定义证据（2026-09-12）

设计见 `docs/design/strategy-loop-v2-and-events-2026-09-12.md` §1/§4。状态机、门与台账集中在 `strategy-loop.ts`，**全部代码判，模型没有任何晋升权**。

**门（`StrategyStatus` 的迁移）**

| 迁移 | 门 | 判者 |
|---|---|---|
| draft → backtest | schema 合法 + 有 `lab_stats` | 代码 |
| backtest → shadow | lab `n ≥ 20` 且期望 `≥ +0.1R` | 代码 |
| **shadow → paper** | **影子实盘** `n ≥ 20`、期望 `≥ +0.1R`、与 lab 期望差 `≤ 0.3R`、最大回撤 `≤ 3R`（四条全过；lab 没有数字时不判第三条）；不过时退回旧口径（回放期望为正） | 代码（新） |
| paper → live_capped | 人批（`confirm=true`），不变 | 人 |
| **任意 paper+ → backtest** | **降级**：最近 30 笔期望 `< −0.1R` **或** 连续 10 笔亏。注意是**退回 backtest 重来，不是 retired** | 代码（新） |

降级同时**自动把该策略移出 `workflow.active_strategies`**，并推一条活动流告警：`kind='workflow_changed'`、`level='warn'`、`data.action = { kind:'open_strategy', label:'查看', method:'GET', path:'/api/strategies/<id>' }`。前端把 `data.action` 渲染成按钮（与 §9.20 阻断告警同一约定）。

**影子实盘（shadow live）**：`shadow` 状态的策略也参加每次扫描的议会表态，但 `StrategyVerdict.advisory = true` —— **只表态，不计共识**（不进 `consensus` 的 voting/agreeing/dissenting/abstaining，也不进线程 `council` 快照）。当它自己给出方向且 `entry_timing='confirmed'` 时建一条**虚拟线程**：

- `ShadowThread = { id, kind:'shadow', strategy_id, version, content_hash, symbol, timeframe, side, opened_at, horizon_end_at, snapshot, status:'open'|'settled'|'unscoreable', r: number|**null**, leg, settled_at, episode_id, note }`。
- **不下单、不占 Portfolio 容量、不进风控、不进 history 胜率**：它存在独立的 `demo_shadow_thread` 表，`demo_threads` 一行都不写。
- 结算：`opened_at` 之后按真实 K 线走 48 根判断周期（与 §9.29 机械基线同一套 `outcome.ts` 走法：下一根开盘进、20 根突破位外 0.8 ATR 止损、1.5R 止盈、到期收盘 mark-to-market）。**零模型**。
- 同一 `(strategy_id, version, symbol)` 同时只许一条 `open`（唯一索引），避免一段行情被重复计数。
- 结算后整体重算写回 `StrategySpec.lab_stats.shadow`：`ShadowStats = { n, win_rate|null, expectancy_r|null, total_r, max_drawdown_r, first_at|null, last_at|null }`，`max_drawdown_r` 是累计 R 曲线的峰谷回撤（正数）。`r = null` 的线程不进任何统计（**NULL 不是 0**）。

**台账 `strategy_events`**：每次状态迁移 / 版本创建 / 降级 / 启停记一行。

- `StrategyEvent = { id, strategy_id, version, at, who, kind, from_status|**null**, to_status|**null**, reason, evidence }`。
- `who: 'code'|'human'|'lab'|'attribution'` —— **模型不在这个枚举里**。
- `kind: 'version_created'|'promote'|'demote'|'retire'|'activated'|'deactivated'`。
- `evidence: Record<string, number|**null**>` —— 判这一步用到的**数字**（`lab_n` / `lab_expectancy_r` / `shadow_n` / `shadow_expectancy_r` / `shadow_max_drawdown_r` / `loss_streak` / `base_expectancy_r` / `probe_expectancy_r` …），不写形容词。

**`GET /api/strategies/:id/timeline`** → `{ strategy_id, events: StrategyEvent[] }`，**旧的在前**（时间线从左往右画），最多 500 行。

`GET /api/strategies/:id` 的响应新增四个字段：`timeline: StrategyEvent[]`（最多 200）、`shadow_threads: ShadowThread[]`（head 版本，最多 50）、`degrade: DegradeDecision`（`{ degrade, reason, n, expectancy_r|null, loss_streak }`，实时算，用来在页面上显示「离降级还有多远」）、`probe_queue: LabProbeItem[]`。

**自定义证据**：`StrategySpec.evidence`（可选）= `{ indicators: {id, tf, params?}[], events: TriggerKind[], info_topics?: string[] }`。

- **进 `content_hash`**：换一套证据就是换了判断输入，必须是新版本。没写 `evidence` 的旧版本 hash **一个字不变**（canonical JSON 里不加这个键）。
- `context.ts` 按**启用策略的 evidence 并集**装指标，每条 `Evidence` 带 `required_by: string[]`（哪几条策略要它；公共行情/结构/记忆等非点名证据是 `[]`）。**没有策略要的指标不进 prompt**。
- `indicators[].id` 必须是指标库 id（§9.10 的 `INDICATOR_SETS`）；算不出来的那条不写（不写 0）。
- `events` 与 `trigger.kinds` **取交集**决定唤醒；`events` 为空 = 不收窄。`GET /api/strategies` 的每条策略带 `wake_kinds`（交集结果）与 `effective_evidence`（没写时显示默认集 `DEFAULT_EVIDENCE`）。
- `info_topics` 命中的新闻在证据里优先（不是硬过滤）。

**归因 → Lab 探针队列**：`AttributionProposal.kind='param'` 的提案除了记忆提案，还会进 `demo_lab_probe_queue`（`LabProbeItem = { id, strategy_id, param, value, source:'attribution'|'human', source_ref|null, queued_at, status:'queued'|'verified'|'rejected', checked_at|null, note|null }`）。**下一轮 Lab 在同一份数据上验证达标（两边样本 ≥ 30、期望高 ≥ 0.15R、胜率不掉超过 5 个点）才 `createVersion` 成 draft**；不达标只把队列项关掉并写明原因。

**发现（假设生成）**：`workflow.strategy_discovery`（布尔，**默认 false**）。开启后在 Reviewer 批次跑完时触发，**每周最多 1 次**，便宜大脑一次调用，产出 ≤ 3 条 `draft`。四道代码校验任一不过 → 整条丢弃并记日志：schema 合法、`checklist.required` 全在代码可算判据集、`evidence.indicators` 全在指标库、`measurableByFunnel` 为真、内容哈希判重。

### 9.28 策略切换：谁能进 active_strategies（2026-09-12）

- **只有 `paper` / `live_capped` 的策略能进 `workflow.active_strategies`**。`applyWorkflowPatch` 仍只做纯语法校验（它看不到策略库）；状态这一关在 `DemoRuntime.setWorkflow` 里把：不合格的 id **不静默丢**，进 `errors`（`策略 X 状态是 backtest，只有 paper / live_capped 能启用` / `策略 X 不在策略库里`），合格的照常写入。口径与 `resolve()` 一致：head 还没晋升但库里仍有 `≥ paper` 的旧版本，算够格。
- **状态退化自动移出**：降级发生时 runtime 把该 id 从 `active_strategies` 移出，落一行 `deactivated` 台账，并推带「查看」action 的 warn（见 §9.27）。
- **在途线程不受影响**：线程钉住开仓时的 `strategy_refs` / `strategy_version`，复查按**钉住的版本**重算；切换只影响新线程。
- **议会票池 = active 全集**，Radar 候选只做优先（不替换票池，见 §9.25 must-fix）。
- **`POST /api/strategies/:id/activate`** / **`POST /api/strategies/:id/deactivate`** → `{ active: string[], workflow, strategy }`。在现有集合上增删一个 id，前端不用自己拼全集；被状态闸拒时返回 `409` + `errors`。两者都落一行 `activated` / `deactivated` 台账（`who='human'`）。
- `GET /api/strategies` 的每条策略新增 `activatable: boolean`（有没有 `≥ paper` 的版本）与 `shadow_blocked: string|**null**`（shadow 状态时离 paper 还差什么，见 §9.27 的门）。UI 用它决定「启用」按钮是否可点，而不是自己推状态。

### 9.34 自定义证据编辑器 + 证据装载计划（减黑盒，2026-09-12）

设计：`docs/design/strategy-research-v3-and-event-research-2026-09-12.md` §5。两件事：**证据集能改**（改 = 出新版本），**模型看到了什么能查**（每次判断落一份装载计划）。

**`PUT /api/strategies/:id/evidence`** — body `{ evidence: StrategyEvidenceSpec | **null** }`。

- `evidence` 进 `content_hash`（§9.27），所以这条路由**一定**走 `createVersion` 出一个 `draft` 新版本，**旧版本一个字不改**。没有「原地保存」这条路。
- `null` = 清空，回到 `DEFAULT_EVIDENCE`（不是「不改」；不改就别调这个端点）。缺 `evidence` 键 → `400`。
- 校验（`strategies.ts` 的 `validateEvidenceSpec`，纯函数）：
  - `indicators[].id` ⊆ 指标库 `INDICATOR_SETS`（§9.10），否则 `400 指标库里没有 X`；
  - `indicators[].tf` ⊆ `1m/3m/5m/15m/30m/1h/2h/4h/1d`，否则 `400 无效周期 X`；
  - `indicators[].params` 的值必须是有限数字；同一 `(id, tf)` **去重不报错**（UI 多点一下不是错误）；
  - `events` ⊆ `TriggerKind` 全集（`TRIGGER_KIND_VALUES`），否则 `400 无效触发种类 X`；
  - `info_topics` 是字符串数组，逐条 `trim().toLowerCase()`，空串丢弃、去重；
  - 规模上限 `EVIDENCE_LIMITS = { indicators: 24, events: 24, info_topics: 12, topic_chars: 32 }`。
- 通过校验的值**已规范化**（排序 + 去重），所以同一套证据只会有一个 `content_hash`。
- 响应 `201 { strategy: StrategyView, from_version: number }`；内容与当前 head 一模一样 → `409 内容没有变化,不生成新版本`；策略不存在 → `404`。
- 落一行台账 `strategy_events`：`kind='version_created'`、`who='human'`、`reason` 含「人工改证据集」。

**证据装载计划 `evidence_plan`** —— `context.ts` 在装证据处产出，落进 `Episode`（JSON 列，**无迁移**）。

- `Episode.evidence_plan?: EvidencePlanDetail`、`Episode.evidence_plan_hash?: string`；旧 episode 两个都没有 → 前端显示「没有计划快照」，不是错误。
- `EvidencePlanDetail = { version: 'ep-v1', hash, strategies: string[], requested, items, counts }`
  - `requested = { indicators: {id, tf, required_by}[], events: TriggerKind[], info_topics: string[] }` —— 启用策略证据集的**并集**（`evidencePlan()`）。
  - `items: EvidencePlanItem[]`，`EvidencePlanItem = { kind, key, label, required_by, included, ref|**null**, source, note|**null** }`。
    - `kind: 'indicator'|'event'|'news'|'research'|'checklist'` —— 这条证据是**哪一路**进 prompt 的；`research` 目前只有事件简报。
    - `included=false` = **要了但没装上**，`note` 写原因（`1h 只有 12 根 K 线(要 30 根)` / `快照里没有这个指标的值`）。不记这一行，前端就分不清「没要」和「要了没有」。
    - `ref` = 装上了的话对应的证据编号 `E7`，没装上是 `null`。
    - `required_by` = 哪几条启用策略点名要它；**公共证据（行情/结构/记忆）是 `[]`，不是「没人用」**。
  - `counts = { requested_indicators, included_indicators, events, news, research, checklist }`。
  - `hash = sha256({version, strategies, indicators(id@tf), events, info_topics})` —— **只覆盖「要什么」，不覆盖「拿到没有」**。所以同一套启用策略的连续判断共用一个 hash，可以直接按它分组比较。
- `Evidence.required_by`（§9.27 已有）与 `items[].required_by` 同源。

**`GET /api/judgments/:id`**（`id` = `episode_id`，只读，零模型，不重算任何东西）→

```
{ episode_id, at, symbol, mode:'scan'|'review', prompt_version, context_hash,
  evidence_plan_hash: string|**null**, evidence_plan: EvidencePlanDetail|**null**,
  evidence: Evidence[], strategy_refs: {id, version, content_hash}[],
  cited_refs: string[],            // 判断真正引用了的证据编号
  ledger: JudgmentLedgerRow|**null** }   // §9.29 的账本行，还没落行时 null
```

不存在的 episode → `404`。

**前端**

- 策略详情抽屉：只读的证据块（§9.27）下面是 `components/strategy/EvidenceEditor.tsx` —— 指标库按分类分组、按周期分列的勾选格（分类表写死在前端，网关只给 id 列表）、事件多选、新闻主题输入；保存 = 新草稿，成功后滚到晋升时间线（那行 `version_created` 就是回执）。按钮文案必须说清「保存 = 出一个新草稿」。
- 判断记录页「看到了什么」：顶部一块证据计划（hash 前 8 位、各类计数、按哪几条策略的并集装、**要了没装上**的逐条原因），下面每条证据标来源种类与 `required_by`。
## 9.33 事件研究与动态日历（P5，2026-09-12）

沿用 `/api/market-events` 作为事件资源；`/api/events` 仍是 SSE。所有时间为 unix 毫秒整数，展示按浏览器本地时区。以下字段在旧行中可缺失，UI 必须以未知显示，不能补零。

### 日历与事件增量

`MarketEvent` 新增 `consensus/previous/actual/surprise: string|null`、`actual_metric?: string`、`actual_refs?:string[]`、`research_status?: planned|running|done|failed|cancelled|null`。日历的预期/上次保留源的单位文本（如 `0.2%`、`130K`）；官方 actual 与 surprise 是十进制字符串，单位由 `actual_metric` 解释：`index_level`、`mom_pct_sa`、`yoy_pct`、`payroll_change_thousands`、`target_upper_pct`。不能把指数水平、同比和季调环比混为一列相减；不可比时 surprise 为 null。

`calendar?: { subkind, metric?:string, title, expected_at, source_ref, consensus, previous, importance:'high'|'medium'|'low', calendar_status:'confirmed'|'reported'|'conflict', observations:CalendarFact[], verified_at, forecast_verified_at?:number, fallback:boolean }`。

- 同一发布的m/m和y/y分别保留metric与预期，不因官方通用标题而丢失口径。两独立来源时刻相同为 confirmed；单源 reported；不同时刻为 conflict，observations 保留各源时间。冲突事件主时间优先官方，不能理解成消除了冲突。
- 静态兜底为 reported + fallback=true，不构成第二独立来源。
- 列表的 `calendar.last_verified_at` 兼容旧键，现表示最近刷新尝试时间（未尝试 null）；新增 `calendar.warnings:string[]`。各条真实核对结果以 event.calendar 为准。
- `briefs[]` 可有多份研究产物，不再限于旧 T−60/T−10 两份。研究简报增加 `source:'research', task_id`，`refs` 指向已保存 excerpt ID。
- `stats[subkind].surprise_move_4h?: {event_id,surprise,move_4h_pct,metric}[]` 保留可回放配对样本，不能将不同 metric 无条件池化。

### 研究 API

| 方法 / 路径 | 请求或返回 |
|---|---|
| `POST /api/research` | `{kind?:'topic'|'event_prep'|'event_release',topic?:string,event_id?:string,due_at?:number}` → 201 `{task}` |
| `GET /api/research?limit=100` | `{tasks:ResearchTask[],usage:{model_calls,fetches},daily_cap:{model_calls,fetches}}` |
| `GET /api/research/:id` | `{task,excerpts:[{id,url,body,at}]}`，body 是不可信原文，只能纯文本展示 |
| `POST /api/research/:id/cancel` | `{task}`；planned/running 可取消，done/failed/cancelled 保持原终态，重复取消幂等 |

自由主题必填 topic，1–1000 字；事件研究必须关联 scheduled 事件，未提供 topic 时沿用标题。due_at 为整数，最多未来一年；发布研究下限为事件时间 +120000，不允许提前偷跑。非法参数400、未知ID404、已dismiss事件409。API仅建任务；下一拍由调度器执行，暂停时留队列。

```ts
ResearchTask = {
  id, kind: 'event_prep'|'event_release'|'topic'|'calendar_refresh', event_id: string|null,
  topic, assigned_by:'agent'|'user', due_at, event_expected_at?:number,
  status:'planned'|'running'|'done'|'failed'|'cancelled',
  phase:'plan'|'fetch'|'extract'|'verify'|'brief',
  plan: null | {sources:{url,why}[],questions:string[]},
  fetches:{url,at,ok,bytes,excerpt_ref,error?:string}[],
  findings:{claim,value?:string,refs:string[],confidence:'reported'|'confirmed'}[],
  brief:string|null,
  cost:{model_calls,fetches,input_tokens,output_tokens,usd:string|null},
  attempts, error:string|null, created_at, finished_at:number|null
}
```

`cost.usd=null` 表示 cheap 通道未提供价格，不伪装为免费；失败、取消后的已预留调用也算预算。workflow 新键 `research_daily_cap={model_calls:20,fetches:100}`，可降至0，不能调高超过硬上限。每日按UTC重置；预算不足保持planned并延至次日。

### 实时更新与证据

SSE 新事件 `market_event` 携带 MarketEvent，`research_task` 携带 ResearchTask。客户端失效 `['market-events']` / `['research']` 前缀；重连成功后补拉快照，不依赖断线期间消息重放。事件页移除30秒轮询，保留人工刷新。

研究完成后落 `InformationEvent {source:'research',source_ref:'/api/research/:id',refs:[excerpt_id],digest:brief,...}`，信息员把这些产物作为已登记来源输入，沿现有新闻证据路径保留 source='research' 和引用文本。事件 briefs 同时留 task_id/refs。P3 若需要判断账本独立的 refs 数组/专用可点开控件，需在其 context/判断页映射扩展，P5 不越界改该文件。

### §9.33 P5b 补正（2026-09-12）

事件触发的 `Trigger.hits?` 是入队时按币冻结、判断前复核后的 `TriggerHit[]`；event hit 追加可选 `event_id/event_subkind/source_ref/research_task_id`。判断触发证据同步展示这些来源，历史记录缺字段继续可读。`StrategyEvidenceSpec.events` 除普通 TriggerKind 外允许 `EVENT_SUBKINDS`：普通触发仍取 trigger.kinds 交集，显式 subkind 订阅增加 event 入口、逐条匹配并遵守最小周期。窗口外/撤销/资产不符的事件不得靠旧缓存唤醒。当前背景事件不改变人工扫描语义。

一手事件简报必须是 `source=research` 且有 `task_id` 的任务产物；refs 为任务的摘录 ID，可从 `/api/research/:id` 的 excerpts 追溯原文。旧 brief 仅作历史展示，不进入一手简报上下文。前端简报数不再显示 `/2` 或当作调用次数，调用预算以研究任务持久化 cost 为准。
## 9.32 Strategy Lab v3：OOS、净值、置信区间与判断回放

`POST /api/strategies/lab/run { "days": 90 }`，days为81..730整数。返回 `{manifest,result,proposals}`；只产生经过验证的draft，不切active。`result.execution_manifest` 冻结实际币池、`result.data_hashes` 为币种/周期缓存摘要，`result.manifest_hash` 对应执行manifest。输入manifest仍保留预注册候选。

`result.by_strategy[].replay` 在新入口按确切版本展开写入 `strategy.lab_stats`。旧记录这些字段缺省，前端必须显示“尚无OOS/净值统计”，不能回退到旧gross显示为净值。

```ts
lab_stats: {
  run_id: string; at: number; symbols: number; setups: number;
  n: number; win_rate: number | null;
  expectancy_r: number | null; total_r: number; // Lab v3旧兼容字段为net
  gross?: { expectancy_r: number | null; total_r: number };
  net?: { expectancy_r: number | null; total_r: number };
  is_expectancy?: number | null;
  oos_expectancy?: number | null; oos_net_expectancy?: number | null;
  oos_n?: number;
  oos_ci?: { status: 'sufficient'|'insufficient'; lower: number|null; upper: number|null; iterations: number; block_size: number };
  dsr?: number | null; // 有符号 SR−试验择优基准，>0才过此门
  dsr_probability?: number | null; // 论文定义的0..1概率，与dsr区分
  sharpe?: number | null; expected_max_sharpe?: number | null;
  trial_count?: number;
  max_dd_r?: number; // OOS净R累计曲线的最大回撤
  regime?: Record<'trend'|'range'|'high_vol'|'unknown', {n:number;net_expectancy:number|null}>;
  universe_rule?: string;
  folds?: {train_from:number;train_to:number;test_from:number;test_to:number}[];
  coverage?: Record<string,number>; // decisions/funding_observations/oi_observations/funding_estimated，及setup coverage计数
  shadow?: { /* §9.27旧字段保留 */
    n:number; expectancy_r:number|null; max_drawdown_r:number;
    net_expectancy_r?:number|null; net_max_drawdown_r?:number|null;
  } | null;
}
```

`n<30` 的 CI 为 insufficient/null；null不等于0。unknown桶不计入“至少两桶非负”。展示gate_check事件的 evidence：`oos_n_missing / oos_ci_lower / oos_ci_gap / dsr / dsr_gap / regime_buckets_missing / max_dd_excess_r / shadow_n_missing / shadow_net_gap / shadow_net_dd_excess / shadow_oos_divergence_excess`，均number或null；严格大于0的门在恰好0时仍被阻断，不能仅靠gap=0判断通过。

回测请求可传 `legs: ('model'|'council'|'mechanical')[]`，必须非空；`['council','mechanical']` 不创建模型大脑，估价为0，`summary.leg_stats[leg]={n,gross_expectancy,net_expectancy}`。省略legs保留旧线程回放语义。ledger新行 `source='replay'`，episode_id前缀`replay:`，未选择腿为null；所选flat腿为0R。历史线上查询的source过滤还需主线接入，详见设计文档§5，前端不能直接将两类行合并统计。

成本兼容：Lab v3顶层expectancy为net；传统funnel/线程回测旧expectancy/r仍为gross，新UI使用明确gross/net字段。判断回放ledger leg.r为net，并附gross_r/funding_estimated。

### §9.32 P1b 补正：策略成绩与有效样本

策略成绩区增加「代码方向代理成绩」「完整策略成绩」两栏；完整策略栏读取 `lab_stats.shadow.full_strategy` 的汇总（顶层兼容字段同值），方向代理读取 `direction_proxy`，两者禁止混算。完整策略栏指零模型代码计划的完整入场/退出/成本实验；含模型回放仍显示为 eval。`n` 标为「有效 n」（4h 行情簇），`raw_n` 为原始成交数；完整栏显示净期望/净回撤，无数据为 `—`。

`health_by_backend[backend] = {status,generation,window_from}` 是该版本当前通道健康状态；API 的状态视图、激活资格和晋升采用当前 backend，旧有效版本不因新 draft head 而退出健康检查。人工晋升可传 `version` 指定旧版本，并绑定当前 backend。shadow 线程新增 `setup`、`score_kind`、`backend`、`generation`、`horizon_bars`、`equity_marks`；缺水位时维持 open 并带重试时间，不算已结算样本。


### 9.35 策略自动轮换 allocator + `active_mode`(2026-09-12)

设计 `docs/design/strategy-research-v3-and-event-research-2026-09-12.md` §4;Codex 复审 `.codex-reports/merge-review-0912.md` §4 第 7 条
(「自动晋到 paper **不会**自动添加 active;这条缺失不能靠把模型直接接 setWorkflow 弥补」)。

**`workflow.active_mode: 'manual' | 'auto'`,默认 `manual`。**

- `manual` = 今天的行为:票池只有人改(`/activate` `/deactivate` `/active`),allocator 只算预览不落。
- `auto` = allocator **每天一次**用代码决策票池。**模型没有任何一条路径能改票池**(`who` 只会是 `code`/`human`)。
- 自动晋级到 paper 的策略**不会**自动进 active:它只进「候选」并发一条 info 告警,真正进票池要么人点,要么下一次 allocator 决策把它排进前几名。

**决策规则(纯函数 `allocatorDecide()`,`strategy-allocator.ts`)** —— 按顺序:

1. **候选** = `status ∈ {paper, live_capped}` 且**健康**(`degradeDecision()` 不判降级)。其它状态一律不进候选,理由写 `status`。
2. **排序** = 按 regime 分桶后的最近 30 天 **net 期望**降序。字段口径:
   `lab_stats.regime_buckets[<当前 regime>].net_expectancy_r` → `lab_stats.net_expectancy_r` → `lab_stats.oos_net_expectancy` → `lab_stats.expectancy_r`(**毛值,TODO 等 §9.32 的 net/oos/regime 桶合入后去掉这一档**)。
   用到了哪一档写在 `expectancy_source`(取值:`'regime_net' | 'net' | 'oos_net' | 'lab_gross' | 'none'`,
   与上面四档一一对应,`none` = 一个数都没有),前端**必须**显示它,`lab_gross` 要明确标「毛值」,
   不能让用户以为毛值是净值。期望为 `null` 的排最后。
3. **每族最多 1 条**(`family`),后来的写 `family_taken`。
4. **相关票去重**:`correlation_key = sha1(evidence 指标 (id@tf#params) 排序 ∪ trigger.kinds 排序)` 相同的两条策略只留期望高的那条(理由 `correlated`)——看同一批证据的两条策略在议会里不是两票,是一票投两次。
5. **最短驻留 3 天**(`ALLOCATOR_MIN_TENURE_DAYS`):在池里不满 3 天的不许被换下去(**健康问题除外**,退化永远立刻出池)。
6. **冷却 1 天**(`ALLOCATOR_COOLDOWN_DAYS`):被 allocator 换下去不满 1 天的不许再进池。人工启用不受冷却约束。
7. 取前 `WORKFLOW_BOUNDS.active_strategies_max` 条。

**留痕**:每次 `changed` 的决策逐条写 `strategy_events`(`who='code'`,`kind='activated'|'deactivated'`,`reason` 是那一句话),
并发一条 activity `kind='active_set_changed'`、`level='info'`,`data = { from, to, add, remove, mode, regime }`。

**回滚**:上一票池存在 kv `allocator.previous_pool`,`POST /api/strategies/allocator/rollback` 一步换回去,
同样写台账(`reason` 含「回滚」)。回滚**不受**最短驻留/冷却约束(它是人的撤销键)。

**HTTP**(`routes-strategies.ts`;evidence / lab 端点不动):

```
GET  /api/strategies/allocator
→ { mode:'manual'|'auto', max, active: string[], regime: DailyRegimeKind|null,
    decision: AllocatorDecision|null,        // 现在跑一遍会怎么动(**预览,不落库**)
    candidates: AllocatorCandidate[],        // 每条一句话「为什么在/不在票池」
    last_run_at: number|null, last_change_at: number|null, last_reason: string|null,
    previous: string[]|null,                 // 可回滚到的上一票池(null = 没得回滚)
    events: StrategyEvent[] }                // 最近 20 条 activated/deactivated 台账

POST /api/strategies/allocator/mode      { mode }        → { mode, workflow }
POST /api/strategies/allocator/run       { force?: bool } → { decision, active, applied }
POST /api/strategies/allocator/rollback  {}              → { active, previous, restored }
```

- `AllocatorDecision = { version:'alloc-v1', at, mode, regime, changed, from: string[], to: string[],
  add: {id, reason}[], remove: {id, reason}[], keep: {id, reason}[], reason }`
- `AllocatorCandidate = { id, name, family, family_label, version, status, in_pool, eligible,
  expectancy_r: number|null, expectancy_source, n: number|null, healthy, health_reason,
  correlation_key, blocked_by: 'status'|'health'|'family_taken'|'correlated'|'cooldown'|'rank'|null, reason }`
- `POST .../run` 在 `manual` 下只有 `force=true` 才落库(否则 `applied=false`,只回预览)。
- `mode` 非法 → `400`;没有上一票池时 rollback → `409 没有可回滚的票池`。

**前端**(策略页顶部「当前票池」区):

- 「手动 / 自动」切换(写 `active_mode`);自动时显示上次决策时间与下次决策日。
- 每条策略一行「为什么在 / 不在票池」:优先 `candidates[].reason`,旁边挂最近一条 `events` 的 `reason`(台账原文)。
- 「回滚到上一票池」按钮:`previous` 为 null 时禁用,禁用态要说明「没有可回滚的票池」。
- 设置页「自动化」组补:`active_mode`、`strategy_council`、`council_min_agree`、`council_model`、`entry_style`、`lab_autopilot`、`strategy_discovery`。

**不做**:让模型选票池;allocator 改任何经济字段(它只动 `active_strategies` 这一个数组)。

### 9.36 议会票池冻结与 min_bars 聚合(P1-06,2026-09-12)

Codex `.codex-reports/merge-review-0912.md` P1-06 四条,逐条口径:

1. **K 线深度按 tf 聚合取 max**:`klinePlan()`(strategy-council.ts)把「票池全集(active ∪ shadow ∪ Radar 候选)各自的 `checklist.min_bars`」
   与「evidence plan 里每个周期请求的指标」合成 `Record<tf, bars>`,**同一 tf 取 max**。runtime 按这张表拉,不再用
   `{[tf]:kTf,'1h':k1h,'4h':k4h}` 这种后写覆盖前写的字典(tf=1h 时 400 根被覆盖成 120 根)。
2. **票池冻结**:`CouncilSnapshot` 新增 `pool_hash`(`poolHash()` = sha256 of `id@version@content_hash` 排序)与
   `pool: {id, version, content_hash}[]`(**全票池**,不只主策略);`votes[]` 也补 `content_hash`。
   复查时 `pinnedPoolFrom(snapshot, lookup)` 按快照里的版本逐条取回——**停用不会让它消失,升级不会换掉它的规则**。
3. **停用对 Radar 也有硬效力**:`effectivePoolIds()` 是唯一口径 —— Radar 候选只能**排前**(优先),
   不能把一条已经从 `active_strategies` 停掉的策略再塞回正式票池。§9.25 的「全集 ∪ 候选」按这条收窄。
4. **同 ID 多版本**:`runCouncil` 的影子去重键从 `strategy_id` 改成 `strategy_id@version`,
   v1 paper 在跑时 v2 shadow 照样有自己的影子票(版本升级最常见的场景)。

**证据 fail-closed**(P1-11):`CouncilInputs.evidence_gaps?: Record<strategyId, string[]>` ——
一条策略点名要的指标这次**没装上**,它这一轮直接 `abstain`(`abstain_reason='data'`),理由写「证据缺 X」。
缺证据的策略投票 = 拿看不见的东西投票,比弃权更危险。

**公共最小集**(P1-11):`context.ts` 无条件装的那一批显式固定成 `PUBLIC_MIN_EVIDENCE`:
行情四行(最新价/资金费/OI/24h)、**主周期 + 1h + 4h(+ 持仓线程的 1d)** 的结构行、主周期最近 4 根、
日线状态、交易时段、本次触发器、记忆。**evidence 请求带进来的额外周期不再自动获得结构行**——
要它就在 evidence 里点名要指标。`evidence_plan.items` 里这些行 `kind='structure'`、`required_by=['(公共最小集)']`。

**evidence plan 的键含 params**(P1-11):`evidencePlan()` 去重键从 `id@tf` 改成 `id@tf#<params 规范化>`,
同一个 RSI 不同参数不再折叠成一条(以前永远渲染 RSI14,用户点的参数永远缺席)。
`IndicatorRequest.params?: Record<string, number>`,`evidencePlanHash()` 一并把 params 算进去。

### 9.37 策略归因 + 短中长分层 + 决策记录(2026-09-12 晚)

设计:`docs/design/attribution-and-tiers-2026-09-12.md`。三件事是一件事的三面 ——
归因缺了分层就是把 5m 和 1d 的 R 混在一个池子里平均;归因缺了决策记录就只能解释已成交的那些,
解释不了「它本来想做但被拒了」那半边。

#### A. 归因报告(只读,零模型,零网络)

**口径**(违反任何一条的数字都不该出现在这份报告里):

- **一笔样本** = `status='closed'` 且 `settlementComplete(t) === true` 的线程。非 complete 的一律不进统计。
- **净 R** = `settlement.net_pnl / initial_risk_usdt`,与 `strategy-loop.realizedRFromThreads` 逐字同一套公式
  (含手续费与资金费);退档时 `r_source='price'`,报告里 `price_only_n` 显出来。**没有任何一个毛值。**
- **汇总键** = `(strategy_id, strategy_version, backend)`。v1 和 v2 是两条策略;paper 与 agent_mcp 不相加。
- **样本不足** = 整块 `n < 10`(`ATTRIBUTION_MIN_SAMPLE`)→ `insufficient: true`,块内**推断量**
  (期望/胜率/中位数/差值)全 `null`,**计数量**(每桶几笔)照常给。

```
GET /api/attribution/summary?backend=&since=&window_days=
→ { backend, since, generated_at, min_sample,
    by_tier: { tier:'short'|'mid'|'long', strategies, n, net_r_sum, expectancy_r: number|null, insufficient }[],
    strategies: AttributionReport[] }

GET /api/strategies/:id/attribution?version=&backend=&since=&window_days=
→ { strategy_id, backend, since, generated_at,
    versions: AttributionReport[],          // 该策略每个有样本的版本一份
    report: AttributionReport | null }      // 点名的那版;没样本时 null(不拿别的版本冒充)
```

`AttributionReport` 的五个维度:

```
version:'attr-v1', strategy_id, strategy_name, strategy_version, backend, tier, horizon,
n, expectancy_r, win_rate, net_r_sum, insufficient, min_sample, window: [from,to]|null, price_only_n,

direction: { insufficient, n,
  long / short: { n, net_r_sum, expectancy_r, win_rate },
  skew }                                  // long 期望 − short 期望;正 = 只有多头能赚

frequency: { insufficient, window_days, opens, opens_per_week,
  opportunities, opportunities_per_week, conversion,
  blocked: { gate, n }[],                 // gate 是 GateResult.name,不是自由文本
  coverage_from, note }                   // 机会数与被闸拒**只来自 decision_record**

exits: { insufficient, n,
  by_kind: { kind: ExitKind, label, n, share, expectancy_r }[],
  mae_r_p50, mfe_r_p50,                   // 线上不记录逐根极值 → null + note,不编近似值
  stop_distance_pct_p50, cost_over_risk_p50, note }

period: { insufficient, online_timeframes: {tf,n}[], replay_timeframe, consistent,
  mismatch: {tf,n}[], live_net_expectancy_r, replay_oos_net_expectancy_r, gap }

screener: { insufficient, n, by_origin: { origin: SymbolOrigin, label, n, share, expectancy_r }[] }
```

- `ExitKind = 'stop' | 'take_profit' | 'expiry' | 'invalidation' | 'manual' | 'other'`
- `SymbolOrigin = 'radar' | 'whitelist' | 'watchlist' | 'manual' | 'unknown'`,判定顺序写死:
  `source !== 'agent'` → manual;命中候选表且开仓时刻在 `[created_at, ttl_at]` 内 → radar;
  白名单 → whitelist;观察名单 → watchlist;都不是 → unknown(币已删掉,不编)。
- `replay_timeframe` 取该版本 `lab_stats.timeframe`,缺省 **`15m`**。`gap` = 线上净期望 − 回放 OOS 净期望,
  是这份报告里最贵的一个数:「回放说的」和「真的发生的」之间的距离。
- `cost_over_risk` = (手续费 + 资金费支出) / 初始风险。> 0.2 基本等于「策略在给交易所打工」。

**不做**:归因 propose / 改版本 / 下单(老约束继续有效);不建汇总表(输入全是已落盘数据,
多一张表就多一个可能对不上的副本)。**迁移 0022 因此没有建表**,编号保持可用。

#### B. 短 / 中 / 长分层

```ts
TIER_OF = { scalp:'short', intraday:'short', swing:'mid', position:'long' }
```
四个 horizon 压进三层,`intraday` 归 short(当日了结按定义就是短线)。
没有 horizon 的东西按周期推:`1d/1w`→long、`4h`→mid、其余→short。

```
workflow.tier_policy: Record<'short'|'mid'|'long', {
  max_open_threads,      // 本层同时在手线程上限;0 = 继承全局
  max_opens_per_day,     // 本层每日开仓上限;0 = 继承全局
  entry_styles: ('market'|'limit')[],   // 空 = 不限
  council_min_agree,     // 0 = 继承全局
  allocator_slots        // allocator 每层名额;0 = 不限
}>
```

**默认全 0 / 空 = 与分层上线之前逐字同一个行为。** 新闸的默认必须是「什么也不改」,
否则这次发布会在用户没按任何按钮的情况下改掉钱的行为。`POST /api/workflow` 支持**部分合并**
(传 `{tier_policy:{short:{max_opens_per_day:2}}}` 只改这一格);越界/不认识的层/非法 `entry_styles`
**报错而不是静默钳**;老库缺字段或手改坏 → fail-closed 回默认(不回一个更松的数)。

- **闸**:开仓提议上多三行 `{层}每日开仓上限` / `{层}容量上限` / `{层}入场方式`。
  配额为 0 时这三行**仍然在**、且 `passed: true` 写「继承全局/不限」——闸的行数不随配置变化,
  否则「今天为什么少了一行闸」又是一个黑盒。`GateContext.tier` 不传 = 一行都不多。
  分层闸**只在 `PROPOSE` 上判**:EXIT/REDUCE 永远不会因为本层满了被拦住。
- **allocator**:`AllocatorCandidate` 新增 `tier`;`blocked_by` 新增 `'tier_slot'`。
  名额判定插在「每族 1 条 / 相关票去重」**之后**、驻留/冷却/容量**之前**:先决定谁够格排队,再谈谁留下。
- **前端**:策略页按层分组(三个分区,每区一行小计);设置页「自动化」组下新增「分层配额」子区。

#### C. 决策记录(减黑盒)

每次判断落一条 `decision_record`,挂在 **Episode JSON 上**(与 episode 严格 1:1,和 `evidence_plan`
同一个模式,不另立表)。`GET /api/judgments/:id` 追加 `decision_record` 字段;老 episode → `null`。

```
DecisionRecord = {
  version:'dr-v1', at, tier,
  allowed:  { actions: Action[], entry_styles, council: {reached,direction,agreeing,required}|null,
              strategies: {id,version,content_hash}[], codes: DecisionReasonCode[] },
  model:    { action, direction, entry, confidence, illegal_action, codes },
  executed: { action, passed, blocked_by: string[], intent_id, codes },
  evidence_plan_hash, strategy_version_hash }
```

`DECISION_REASON_CODES`(全量枚举,**三个 `codes` 字段的类型就是它,不是 `string`**):

```
// 一、代码给的允许集
code_graph_edges | code_council_consensus | code_council_no_consensus | code_council_off
code_entry_free | code_entry_prefer_limit | code_entry_limit_only | code_no_strategy
// 二、模型选了什么
model_within_allowed | model_illegal_repaired | model_failclosed | model_no_output
// 三、闸之后真的执行了什么
gate_pass | gate_blocked | gate_not_applicable
gate_tier_daily_cap | gate_tier_capacity | gate_tier_entry_style
exec_intent | exec_awaiting_approval | exec_none
```

「黑盒」的具体形态就是「理由是一句人写的话,没法聚合、没法对拍、没法当统计维度」。
换成枚举之后,A 里的「被闸拒的分布」才是一个能画出来的直方图。`tsc` 是主校验器;
`isDecisionReasonCode()` 给 JSON 反序列化的边界用。

- `allowed.actions` 目前是动作全集:图快照只落 node/edge/guards,不落「这个节点的合法边全集」。
  等 `graph.ts` 开始写合法边,换成那份即可(字段形状不变)。
- `strategy_version_hash` = sha1(排序后的 `id@version@content_hash`) 前 16 位,与顺序无关。
- `blocked_by` 是闸名数组(`GateResult.name`),不是自由文本;分层闸另给 `gate_tier_*` 码,
  这样直方图能把分层拒和别的拒分开数。

**前端**(判断记录页展开区新增 `decision` 页签):三栏并排 **代码允许 →|模型选 →|闸后执行**,
每栏下面是它的 reason code 徽章(中文标签在前端的 `DECISION_REASON_LABEL` 里,**后端只发 code**)。
三栏之间不一致的地方(模型选了允许集外的、闸把模型选的拒了)标出来 —— 那几处就是「黑盒在哪里」的答案。

### 9.38 跟单 session(Trader Follow,2026-09-12)

设计 `docs/design/trader-follow-2026-09-12.md`(**首发范围看它的 §6「首发范围收缩」**);后端已实现
(`packages/gateway/src/demo/trader-*.ts` + `routes-follow.ts`),**前端另起一包做「跟单」页**:
交易员卡片(模式/权重/统计)、信号流(状态、agent 结论、跟/跳按钮)、设置。

**首发跟单链路不做任何自动的交易所写操作**(设计 §7)。拉取 → 判定 → 落 `review_only`,**到此为止**;
真正下单只发生在人点 `apply` 之后。

**零写承诺的范围**:指跟单链路自身(feed / capture / 判定 / ingest / resume / 信号级巡检)。
**不包括**人工 apply 之后那条线程的既有生命周期 —— 它是一条**普通手动线程**,成交后补保护、
到点复查、结束时撤单都是 runtime 对所有线程一直在做的既有行为,不是跟单的承诺。
旧版本遗留的 `origin:'trader:*'` 线程同样按普通线程处理。
`GET /api/follow` 的 `scope` 就是这张表,**前端按它画说明,别自己硬编码**:

```jsonc
"scope": {
  "auto_execution": false,                 // 首发:跟单链路零自动交易所写
  "human_actions": ["apply", "skip", "reconcile"],  // 没有 close:平仓去交易页
  "auto_actions_when_enabled": ["open", "add", "close", "stopped_out", "cancel"],  // 等开闸时才放开
  "manual_only_actions": ["reduce", "stop_loss_update", "take_profit_update"],     // 永远人工
  "auto_manage": false,
  "tp_tiers": "first_only",                // 开仓只挂第一档止盈(= 第一档全仓退出)
  "ladder_entry": "manual_only"
}
```

每类信号首发落到哪个状态:

| 信号 | 状态 | 前端 |
|---|---|---|
| `open`/`add`,copy | `review_only` | 给「跟 / 跳」;几何看 `decision.plan` |
| `open`/`add`,gated 且 agent 同向 | `review_only` | 同上,另外显示 `decision.agent` |
| `open`/`add`,gated 且 agent 反向/不入场/被闸拒 | `skipped` | 只读;`decision.agent` 说明为什么不跟 |
| `open`/`add`,evidence | `evidence` | 只读 |
| `close`/`stopped_out`/`cancel` | `review_only` | 只给「跳」;要平仓**去交易页**(`thread_id` 指出是哪条线程) |
| `reduce`/`stop_loss_update`/`take_profit_update` | `review_only` | 只给「跳」;执行要人自己去线程页做 |

**可执行前态只有两个**:`review_only`(判定完、等人拍板)与 `apply_failed`(明确失败、可以再试)。
只有这两档有按钮(`apply` / `skip`);其余状态一律只读。服务端自己认这一条 ——
对别的状态调 apply/skip 一律 409,不靠前端禁用按钮。
另外 `needs_reconcile: true` 的行**两个按钮都不给**,先 `reconcile`。

**状态机**(五审后):

```
review_only ─apply(原子领取)─▶ applying ─┬─ opened ────────────▶ applied
apply_failed ─apply(可再试)──▶           ├─ rejected ──────────▶ apply_failed(明确失败,可再试)
review_only ─skip────────────▶ skipped   ├─ failed_before_send ─▶ apply_failed
                                          └─ unknown(已发出)──▶ review_only + needs_reconcile
```

- **领取是原子的**:`apply` 用条件更新把行改成 `applying` 并写下 `claim_id`(这次操作的唯一 id)。
  并发的第二次点击拿不到 → 409。发送前与结果保存都校验 `claim_id` 仍是自己的,
  不是了就放弃保存(旧快照不覆盖新状态)。
- **`needs_reconcile: true` = 上次可能已经发出、结果未知**。这一档 **apply 与 skip 都拒**,
  必须先 `POST /api/follow/signals/:id/reconcile`(人工「已核对」,只清标记、不动钱)。
  前端要显著标出来:「上次可能已经发出,请去交易所核对后再点已核对」。
- `apply_failed` 是**明确失败**(闸拒 / 发送前失败,交易所那边什么都没发生),可以再点一次;
  它和 `needs_reconcile` 的行都进 `pending_review`。
- `applying` 行只有在**进程重启**后才会被恢复流程隔离(判据是 `claim_owner` 不是当前进程);
  运行期的活跃领取不会被后台 tick 撤掉。

口径提醒(前端别自己算):
- `weight = manual_weight × auto_mult`;`stale=true` 时 `auto_mult` 为 null,权重取
  `min(manual_weight, 0.5, 最近一次有效权重)` —— 故障状态下的风险预算**永远不高于**最后一次说得清的那个数
  (只设绝对 0.5 是不够的:manual=0.4 而正常权重 0.2 时,单看 0.5 会把它放大成 0.4)。
  `stale_capped=true` 说明它就是因此被压小的,卡片上要标**统计过期**并说明权重为什么变小。
  `auto_mult` 永远 ≤ 1(它是折扣不是杠杆)。
- `agent_agree_rate` / `realized_r` 为 `null` 是「没有样本」,**不是 0**,不要渲染成 0%。
  `realized_r` 只统计结算完整的线程;已平但结算没齐的在 `settling` 里单独给数。
- `stats_window` 是 8794 那个端点的真实口径(`all` = 全量,**不是**近 90 天),照它显示。
- `truncated=true` = 这个人的信号超过 `agg_limit`,逐条派生字段只覆盖最近那一批。
- 后端只发 reason code(枚举),中文标签在前端的 `DECISION_REASON_LABEL` 里;跟单新增 11 个码见 §9.37 那张表的第四组。
- 价格/数量都是十进制字符串,时间戳是 unix 毫秒。凭证任何时候都只有脱敏形状(`sbk_***1234`)。

**凭证**:只从环境变量注入(`TG_FOLLOW_BRIDGE_KEY` / `TG_FOLLOW_BRIDGE_SECRET`)。
`POST /api/follow` **不接受**写凭证(带 `credentials` 会回 207 + 错误说明)——AGENTS.md 第 1 条的规矩是
TS 进程里不得出现 API key/secret,写进 gateway 自己的库就是在 TS 侧持密。前端只显示
`connection.credentials`(`configured` / `source` / 脱敏形状),没有「保存凭证」这个表单。

**设置**(`workflow.follow`,出厂 `enabled:false` + 空名册 = 整条链路不拉不跑):

```jsonc
{
  "enabled": false,
  "bridge_url": "https://bridge.example.com",
  "stats_url": "http://127.0.0.1:8794",
  "freshness_s": 180,                      // live 信号超龄只能 evidence
  "default_mode": "gated",                 // copy | gated | evidence
  "auto_manage": false,                    // 硬开关:仓位管理类动作的自动执行。**永远 false 且改不动**
  "max_signals_per_trader_per_day": 6,     // 0 = 不限
  "backfill_recent": 200,                  // 启动补拉条数(一律 review_only)
  "traders": { "<带单员名>": { "mode": "gated", "manual_weight": 0.8, "enabled": true } },
  "thresholds": { "win_rate_good_pct": 55, "dd_good_pct": 15, "dd_bad_pct": 30, "mult_good": 1, "mult_mid": 0.75, "mult_bad": 0.5 }
}
```

`traders` 与 `thresholds` 是**整块替换**(改一个人也要把整份 `traders` 发上来)—— 半合并会让「删掉一个带单员」永远删不掉。
手改坏的 `mode` fail-closed 回 `evidence`(不是 copy),越界数字钳到边界,`enabled` 必须显式 `true`。

**接口**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/follow` | 设置 + `scope` + 连接状态(游标 / 失败次数 / 下次重试时刻 / DLQ 计数 / 凭证脱敏)+ 权重表 + `pending_review`(**从库里查 `review_only` 与 `apply_failed` 的信号行**,重启后照样完整,不是内存列表)+ `pending_review_total` / `pending_review_limit`(有截断时前端要能看出来) |
| POST | `/api/follow` | body `{ follow? }`。带 `credentials` 或在 follow 里夹带 `api_key` → 207 + `errors`(凭证只走 env) |
| GET | `/api/follow/signals?trader=&symbol=&status=&action=&limit=` | 信号流(新的在前)。非法 `status`/`action`/`limit` → 400 |
| POST | `/api/follow/signals/:id/apply` | 人工下单(`:id` 收本地 id 或 `signal_id`),body 可带 `{ force_stale: true }`。**发的就是行上的 `decision.plan`,不重算**。走既有手动开仓链路(`source:'manual'`):止损校验、名义上限、`preflightOpen`、`entry_style`、事件黑窗、每日开仓上限一条不放过。**原子领取**:并发第二次点击 → 409。非 `review_only`/`apply_failed` / `needs_reconcile` / 无 plan / 无止损 / 反向 / 重复 / 权重 0 / evidence 模式 → 409;超新鲜度要 `force_stale`(**只豁免年龄**,授权照查);`valid_until` 过了或不可信一律不给跟。响应 409 时看信号行的新状态:`apply_failed` = 明确失败可再试,`review_only + needs_reconcile` = 已发出结果未知 |
| POST | `/api/follow/signals/:id/reconcile` | 人工「已核对」:**只清 `needs_reconcile` 标记**,不动钱、不改状态。清掉之后这条才能再 apply / skip。不带标记的行 → 409 |
| POST | `/api/follow/signals/:id/skip` | 人工跳过,body 可带 `{ note }`。已开仓的不许 skip → 409 |
| GET | `/api/follow/stats?since=` | 8794 权重表 + 本地每人:触发数、跟了几单、各状态分布、`agent_judged`、`agent_agree_rate`、`open_threads`、`closed_threads`、`settling`、`realized_r`、`truncated`。名册外但有信号的人也列出来(`weight:0`) |
| POST | `/api/follow/pull` | 手动拉一轮(调试用);`enabled:false` 时什么也不做 |

**SSE**:`trader_signal`,payload 就是一条完整信号行。每条信号**发两次** —— 收到时(`status:new`)与处置完(终态),
前端按 `signal_id` 覆盖同一行即可。

**信号行**(`demo_trader_signal`,迁移 0022):

```jsonc
{
  "id": "tsig_<signal_id>", "signal_id": "sig_123", "record_id": 1204,
  "trader": "TraderB", "symbol": "BTCUSDT", "side": "long",        // side 可为 null(管理动作可能没方向)
  "action": "open",            // open|add|reduce|close|cancel|stop_loss_update|take_profit_update|stopped_out|analysis_only|unknown
  "entry_kind": "limit",       // market|limit|zone|ladder|unknown(zone=区间按方向取一侧挂一张;ladder=多档,本实现执行不了 → review_only 转人工)
  "entry_prices": ["77000"], "stop": "76000", "tps": [{ "price": "79000", "pct": null }],
  "size_pct": null,            // 带单员自称的仓位比重,只留痕;仓位按 risk_pct × weight 自己算
  "valid_until": null, "published_at": 1789228843713, "ingested_at": 1789228843794,
  "raw_text": "突破回踩",       // 已消毒;外部文本一律当数据
  "status": "review_only",     // new|triggered|applying|applied|apply_failed|skipped|evidence|review_only|expired|dead|mgmt_applied|mgmt_orphan
  "invalid_validity": false,   // true = valid_until 在场但不可信(解析不出/早于原发时间):这条永远进不了可执行状态
  "needs_reconcile": false,    // true = 上次可能已经发出但结果没记完,**要人去交易所核对**(不会自动重发);
                               //        这一档 apply/skip 都拒,先 POST .../reconcile
  "claim_id": null,            // applying 期间非空:这一次操作的唯一 id(并发互斥用)
  "claim_owner": null,         // 领取它的进程 epoch;重启恢复据此认出「上个进程遗留」
  "backfill": true,            // true = 补拉/上个会话留下的历史信号:不调模型、不给可执行几何
  "mode_applied": "copy", "thread_id": "thr_x",
  "decision": {
    "codes": ["trader_follow_copy"], "note": "…", "episode_id": null, "weight": 0.8, "at": 1789228843799,
    // gated 的 agent 结论(copy/evidence 为 null):给人的依据,不是执行许可
    "agent": { "stance": "agree", "action": "PROPOSE", "direction": "long", "stop": "76500", "blocked": [] },
    // 人工执行要用的几何(review_only 才有);**计划值**,不是交易所已挂成功的证明
    "plan": { "entry": "77000", "intent": "limit", "stop": "76500", "take_profits": ["79000"], "reason": "…" }
  },
  "created_at": 1789228843794, "updated_at": 1789228843799
}
```

状态该怎么显示:`applied` = 真开了线程(点 `thread_id` 跳线程页);`review_only` = 等人拍板,
**这一档才需要「跟/跳」两个按钮**;`evidence` / `skipped` / `mgmt_orphan` 是终态留痕,只读,理由看 `decision.codes`。
`new` / `triggered` 是**在途**,前端显示「处理中」,不给按钮。两者的恢复语义不同:`new`(一个动作都没发过)
会被下一轮重放;`triggered`(已发出、没记完结果)**永远不重放**,会被隔离成 `review_only` 并标明
「上次已发出未确认,请人工核对交易所」—— 补拉、重投、崩溃恢复三个入口都是这条纪律。

进 `review_only` 的都是「代码不敢自己动手」的那几类,文案要说清是哪一类:
**减仓 / 移动止损 / 改止盈(首发全在这)**、多档阶梯入场、补拉的历史管理动作、迟到超龄的管理动作、
以及两类「状态不确定」——**动作执行没确认成功**(平仓/撤单回执 unknown)和
**上次已发出未确认**(进程崩在发送窗口里,恢复时不重发)。后两类尤其要显眼:
它们意味着场上状态和我们记的可能不一致,必须人去交易所核对。

`tp_partial_unsupported` 非空的线程要在列表与详情上标出来:交易所上只有 `placed` 这一档,
`dropped` 里的档位**没有挂**。不标的话「信号说 110 平 30%、120 平 70%」会被读成已经照做了。

**线程/判断记录多一维**:跟单开的线程 `source:'trader'`、`origin:'trader:<带单员名>'`、`trader_signal_id`;
gated 那次 episode 也带 `origin` 与 `trigger.kind:'trader_signal'`,且**自己不开仓**(`thread_id:null`,线程由信号几何开)。
归因报表按 `origin` 多一维。判断账本里跟单腿是 `source='trader'` 的独立行,默认(`online`)查询看不见它。

**输出脱敏**(五审 R5-03):`/api/follow/*` 的**所有响应**(含错误文案)与**所有 SSE 帧**都过一遍
递归脱敏 —— 对象里每一个字符串字段,包括 `signal_id`、`ref_order`、`decision` 整棵子树
(`note` / `plan.reason` / `agent.blocked[]`)、DLQ 的 id 与 error。除当前凭证的精确替换外,
还按形状兜底 `(sbk|sbs)_[A-Za-z0-9_-]{8,}`(**不区分大小写、不要求词边界**),
所以旧库里遗留的、别人的、已轮换的钥匙形状同样清得掉。库里的 `signal_id` 保持原样(它是幂等键),
带凭证形状的新信号在**入口就被拒收**进 DLQ。

**日志同样在出口清**(六审 R6-02):`runtime.log` 在落 `demo_logs`、`emit('log')`、写 console
三个去处之前,对 `message` 与 `data` 递归脱敏;`GET /api/logs` 读出来时再清一次(兜历史行)。
跟单路由抛出的异常也走本模块自己的 `guarded`,错误响应同样脱敏。

### 9.39 信号市场(Signal Market · OKX.AI ASP,2026-09-20)

本文覆盖旧 §9.38 的设置、连接和统计字段。`packages/webui` 由前端独立实现。所有时间为 unix 毫秒整数；价格、费用、数量与已实现 R 为十进制字符串。平台返回内容是不可信数据。所有市场 CLI 走 `asp-agent/cli.ts`，普通调用超时 20 秒，不自动重试写操作；无 `--autotrade-*`，本批不调用模型。

**设置**：GET/POST `/api/follow` 直接返回/接受 MarketSettings（无 `follow` 外层）；POST 接受部分顶层字段，`subscriptions` 整块替换。GET/POST `/api/market/settings` 同形状加 `publisher`；publisher 支持部分字段更新。旧 bridge/traders/thresholds/stats_url/backfill 字段已移除。出厂值如下：

```json
{"enabled":false,"transport":"queue","poll_ms":3000,"freshness_s":180,"default_mode":"evidence","subscriptions":{}}
```

```json
{"enabled":false,"transport":"queue","poll_ms":3000,"freshness_s":180,"default_mode":"evidence","subscriptions":{"job-1":{"mode":"gated","weight":0.5,"enabled":true,"label":"本地备注"}},"publisher":{"enabled":false,"publish_orders":true,"publish_analysis":true,"symbols":[],"include_realized_pnl":true,"backend_filter":["okx","binance"]}}
```

`mode/default_mode` 为 `book|gated|evidence`（2026-09-20 晚改道：`book` = ASP Agent 把 order 信号归一成候选点位直接交给组合经理那条路 `openThreadFromProposal`——代码算仓位 risk_pct×权重、基础闸、组合限额、风控哨兵，不问模型；旧名 `copy` 读入时映射成 book）；订阅项多一个 `approval:'manual'|'auto'`（默认 manual：过闸后生成待批意图，交易页点确认；auto：直接交执行）；信号行 reason code 新增 `trader_follow_book` / `trader_follow_book_pending`；线程 origin `trader:<jobId>`。weight 为 0–1 数字；poll_ms 为 1000–300000；freshness_s 为 10–86400。`label` 可省略。publisher 可选 `min_confidence:0.7`（0–1）；backend_filter 可含 `paper`，缺省排除 paper；paper 被允许时也只发 analysis。`transport:"watch"` **实验性**，子进程按 stdout 行读取；与 queue 互斥，切换时停止 watch 后才可读队列。copy 仅 open 自动且经过全部既有闸；gated 保留 agent 判断与人工确认；管理动作不自动执行。没有配置的订阅使用 default_mode、weight=0，不自动开仓。

**账户与采集状态**：GET `/api/market/status`，无 body。

```json
{"lights":{"wallet":{"ok":true,"detail":"账户摘要","checked_at":1800000000000},"a2a":{"ok":true,"detail":"running","checked_at":1800000000000},"trade_kit":{"ok":false,"detail":"未接好","checked_at":1800000000000}},"wallet":{"logged_in":true,"email":"a@example.com","account_name":"Main","address":"0x...","chain":"xlayer","balance_usdt":"12.5","deposit_address":"0x...","checked_at":1800000000000},"a2a":{"ok":true,"detail":"running","checked_at":1800000000000},"trade_kit":{"ok":false,"detail":"未接好","checked_at":1800000000000},"buyer":null,"asp":null,"subscribe_cost":null,"inbox":{"transport":"queue","experimental":false,"alive":false,"last_poll":null,"last_error":null,"cursor":0,"received":0,"dlq":0,"analysis":0,"duplicates":0},"errors":{}}
```

buyer/asp 为平台身份对象或 null；subscribe_cost 为 `subscribe-cost` 的 data 原样对象或 null；wallet 为钱包卡（CLI 失败时 null），余额/地址缺失为 null，缓存 30 秒；errors 是失败部件名到错误文本的映射。inbox.duplicates 是本进程看到的重复次数，其余 ledger 计数耐久保存。

买方 enabled、publisher enabled 或已缓存 ASP 身份任一满足时采集器运行，保证仅卖方使用时仍收到售后事件。买方关闭时普通信号仍可入账但标记 backfill，不进入跟单；system 事件只进入售后处理。

POST `/api/market/wallet/deposit-notice` 请求 `{}`，调用 funding-notice，返回：

```json
{"chain":"xlayer","currency":"USDT","deposit_address":"0x...","qr_base64":"iVBORw0KGgo...","mime_type":"image/png"}
```

qr_base64 是 PNG 的 base64，不含 data URI 前缀；CLI 未产出可读 PNG 时为 null，仍可复制地址。钱包未登录/无地址时 409。status/addresses/balance 均走统一 runner，不读取凭证；充值只显示地址，不发送资金。ASP 领取成功后使钱包缓存失效。

**市场**：GET `/api/market/search?keywords=&after=&trial=&max_fee=`。keywords 缺省 `信号 signal 合约 perp`；after 透传 search-after；trial 为 true/1 时只保留可试用项；max_fee 为十进制字符串上限。响应保留平台 data 字段和每个 service 原文，稳定顶层：

```json
{"services":[],"searchAfter":null,"hasMore":false}
```

GET `/api/market/asp/:agentId` 合并三次 CLI data，缓存 5 分钟：

```json
{"profile":{},"services":{},"feedback":{}}
```

这里 `{}` 表示平台 data 原样 JSON（可能为对象或数组），字段由对应 CLI 定义，不另行改名。

**订阅**：POST `/api/market/subscribe` 请求：

```json
{"service_id":"svc-1","provider_agent_id":"8136","fee_amount":"10","fee_token_address":"0x...","use_trial":true,"auto_renew":false,"title":"trade-gate 订阅 · 服务名","description":"接收研究信号","mode":"evidence","weight":0.5}
```

provider_agent_id/title/description 可省略；mode 缺省 default_mode、weight 缺省 0。顺序为 create-subscribe → my-subscriptions 取 thisDeviceId → subscribe-device-update 保留原接收者并加入本机 → 本地配置。deviceList=null（原本所有设备接收）时先查询 device-list 得到设备集合。成功、余额不足、创建成功但设备更新失败三个响应分别为：

```json
{"jobId":"job-1","funding_notice":null,"configured":true}
```

```json
{"jobId":null,"funding_notice":{"address":"平台返回地址","shortfall":"10"}}
```

```json
{"jobId":"job-1","funding_notice":null,"configured":false,"error":"设备更新错误文本"}
```

funding_notice 是 funding-notice 的 data 原样内容，上例仅示意平台字段；命令不能安全解析时返回 `{ "command":"平台原始命令", "error":"原因" }`。不经 shell 执行该命令。configured=false 时订阅已创建，**不可重新 create**；可 PATCH 修复设备并保存配置。

GET `/api/market/subscriptions`：

```json
{"thisDeviceId":"device-1","subscriptions":[{"job_id":"job-1","remote":{},"config":{"mode":"evidence","weight":0.5,"enabled":true},"stats":{"job_id":"job-1","received":2,"order":1,"analysis":1,"followed":0,"realized_r":null,"agent_agree_rate":null,"last_signal_at":1800000000000}}]}
```

remote 为 buyer my-subscriptions 对应 jobId 的原样对象（仅本地配置存在时 null）；包含平台 deviceList/thisDeviceReceives、状态、期次等。thisDeviceId 可 null。PATCH `/api/market/subscriptions/:jobId` 接受以下字段的任意子集；设备更新成功后才保存本地配置：

```json
{"mode":"copy","weight":0.3,"enabled":true,"label":"研究源","this_device_receives":true}
```

```json
{"job_id":"job-1","config":{"mode":"copy","weight":0.3,"enabled":true,"label":"研究源"}}
```

POST `/api/market/subscriptions/:jobId/cancel`、`/autorenew` 请求 `{}`；`/reject` 请求 `{"reason":"拒收原因"}`。响应为相应 CLI data 原样对象。GET `/api/follow/stats` 返回 `{"subscriptions":[...上述 stats 对象...]}`，完全使用本地数据、按 job_id 聚合；realized_r 仅完整结算且有初始风险的线程计入，没样本为 null；agent_agree_rate 是 0–1 或 null。

**入站账本与跟单**：GET `/api/market/inbox?job_id=&status=&limit=`；status 为 parse_status (`order|analysis|invalid|expired`)，limit 1–500 缺省 100，按最新 rowid 返回：

```json
{"deliveries":[{"rowid":1,"delivery_id":"delivery-1","job_id":"job-1","received_at":1800000000000,"raw":"原文，响应截取前4000字，库中全文保留","parse_status":"order","signal_id":"okxasp_delivery-1","signal_type":"order","session":"会话ID","signal":{},"errors":[]}],"inbox":{"transport":"queue","experimental":false,"alive":true,"last_poll":1800000000000,"last_error":null,"cursor":1,"received":1,"dlq":0,"analysis":0,"duplicates":0}}
```

signal 是现有 TraderSignal 或 null（新增 `subscription_job_id:string`；查不到为 `unknown`）；errors 为解析诊断字符串数组。账本 append-only，delivery_id 主键，不因坏行丢原文；system 信封进售后台账，不进此表。cursor 在信号耐久 capture 后才推进。POST `/api/market/inbox/poll` 请求 `{}`，queue 才可调用；总开关关闭时返回零进度：

```json
{"pulled":2,"handled":2,"skipped_analysis":0,"bad_rows":0,"error":null}
```

`/api/follow/signals` 和 apply/skip/reconcile 请求响应沿用 §9.38；signals 新增可选 `job_id` 查询过滤，响应额外提供 `pending_review`（最多 200 条 review_only/apply_failed）、`pending_review_total` 和 `connection`（上述 inbox 状态）。 响应还带 `scope`（首发范围，形状同 §9.38：`auto_execution:false`、`human_actions`、`auto_actions_when_enabled`、`manual_only_actions:['reduce','stop_loss_update','take_profit_update']`、`auto_manage:false`、`tp_tiers`、`ladder_entry`），前端按它画说明。路由参数一律小写下划线（`:agent_id` / `:job_id` / `:event_id`），http.ts 的路由器只认 `[a-z_]`。gated 判断被闸拒（含事件黑窗）→ `skipped` + `trader_gate_blocked`，不落 review_only（与 缺口 4 同口径）。旧 `/api/follow/okx-asp`、`/poll`、`/pull` 与 `/api/okx/account` 保留兼容；没有 bridge 客户端接线。

**ASP 身份**：GET `/api/market/asp`：

```json
{"identity":null,"services":null,"active":null,"subscriptions":null,"claimable":null,"aftersales":[]}
```

有身份时 identity 为 ASP 对象，services/active/subscriptions/claimable 分别为 service-list/subscribe-active/provider my-subscriptions/asp-claimable 的 data 原样对象。

POST `/api/market/asp/validate` 请求下列 Listing JSON，响应 `validate-listing` data **原样**，包括 findings 的所有字段：

```json
{"name":"市场研究员","description":"结构研究服务","service_name":"合约结构研究信号","service_description":"能力与适用用户\n所需材料\n交付说明","pricing":"monthly_trial","fee":"10"}
```

```json
{"pass":false,"findings":[{"field":"service[0].serviceName","code":"N1","severity":"block","message":"平台校验原文"}]}
```

pricing 为 per_call/monthly/monthly_trial，后者固定 72 小时试用。fee 字符串至多 6 位小数。POST `/api/market/asp/register` **multipart/form-data**：Listing 各字段为文本 part，`avatar` 为必填 PNG/JPEG/WebP 文件 ≤1MB。注册本地验证姓名（中文 2–12/英文 3–25）、描述 ≤500、服务名 5–30、金额、敏感词与头像；随后 pre-check → upload → create。响应：

```json
{"created":true,"result":{}}
```

```json
{"created":false,"precheck":{"canCreate":false,"reason":"平台原文"}}
```

precheck 可能包含平台 consent；需要在平台完成其要求后再提交，本次没有自动同意协议。POST `/api/market/asp/activate`、`/deactivate` 请求 `{}`；`/update` 请求 Listing 加 `service_id`，只更新此服务，不覆盖其他服务，不允许切换既有服务的按次/月付模型。三者响应均为 CLI data 原样对象。POST `/api/market/asp/claim` 请求 `{}`，返回 asp-claim-rewards data 原样对象。

**售后**：aftersales 行字段：

```json
{"event_id":"system-event-1","job_id":"job-1","event":"sub_user_reject","asp_id":"8136","buyer":"13529","period":"2","reason":"拒收理由","deadline":1800086400000,"received_at":1800000000000,"status":"pending","decision":null,"result":null}
```

status 为 received/pending/processing/done/failed；未知处理结果保留 failed/processing，不自动重发。sub_renew 自动执行 subscribe-asp-claim，一次事件只尝试一次；sub_user_reject 发 gate_captain handoff；sub_asp_selected 活动标题“新订阅者”。POST `/api/market/asp/aftersales/:jobId`：

```json
{"decision":"dispute","reason":"争议理由"}
```

decision 为 agree_refund/dispute，dispute 必须带非空 reason；仅唯一、未过期 pending 行可处理。响应为对应 CLI data 原样对象。

**出站**：GET `/api/market/asp/deliveries?limit=100`：

```json
{"deliveries":[{"event_id":"event-1","created_at":1800000000000,"event":{"event_id":"event-1","kind":"entry_filled","signal_time":1800000000000,"symbol":"BTCUSDT","direction":"long","price":"64120","stop_loss":"63400","take_profit":["65200"],"reason":"研究判断","thread_id":"thread-1","realized_r":null,"backend":"okx_atk","paper":false},"subscribers":["job-1"],"text":"交易信号 / Trade signal · BTC-USDT-SWAP LONG: 研究判断\n{...完整JSON...}","payload":{"deliveryId":"tg_event-1","signal_type":"order","signalTime":1800000000000,"symbol":"BTC-USDT-SWAP","action":"LONG","price":"64120","stop_loss":"63400","take_profit":["65200"],"leverage":null,"sz":null,"valid_until":1800000180000,"is_executable":true,"reason":"研究判断","source":"trade-gate","thread_id":"thread-1","realized_r":null,"backend":"okx_atk","paper":false},"refusal":null,"jobs":[{"event_id":"event-1","job_id":"job-1","status":"delivered","attempts":1,"error":null,"updated_at":1800000000000,"result":{}}]}]}
```

event kind 另有 thread_closed/sl_hit/tp_hit/reduce_filled/decision_record；可选 transport/confidence/reduce_pct/exit_reason。payload action 为 LONG/SHORT/FLAT/CLOSE/REDUCE；CLOSE 增 `exit_reason`，REDUCE 增 `reduce_pct` 字符串；analysis 增 `can_enter:false` 并 `is_executable:false`。paper 强制 analysis 且 paper:true；外部 okx_asp 或 trader 来源线程不发布。内容与 subscriber set 创建后冻结，同 event 不补发新订阅者。jobs status 为 pending/delivered/failed；失败率严格大于 50% 时 handoff。重启遗留 pending 隔离为 failed 并标记结果未知，必须人工核实后再重发。

POST `/api/market/asp/deliveries/:eventId/retry` 请求 `{}` 或 `{"job_id":"job-1"}`，仅重发失败户，响应单条上述 delivery（无 deliveries 包装）。敏感词/订阅者集合获取失败以 refusal 留痕，不允许 retry 绕过。POST `/api/market/asp/preview` 请求 `{}`，无活跃订阅者才可用；返回 `{"payload":{...上述analysis示例...},"text":"双语行\nJSON"}`，不发送。

**SSE**（已有 `/api/events`）：

- `market_delivery`: `{"delivery_id":"d1","job_id":"j1","parse_status":"order","signal_id":"okxasp_d1"}`。
- `market_publish`: 单条上述 outbound delivery 对象。
- `market_subscription`: `{"job_id":"j1","action":"created|updated|cancel|reject|autorenew"}`。
- `market_aftersale`: 收到事件为 `{"event_id":"e1","job_id":"j1","event":"sub_user_reject"}`；决策完成为 `{"job_id":"j1","decision":"dispute","result":{}}`。

错误统一 `{"error":{"code":"error","message":"说明"}}`（CLI 为 cli_timeout/cli_invalid_json/cli_failed）；HTTP 参数错误 400、不存在 404、状态冲突 409、头像体积 413、CLI 失败 502。手动 poll 部分失败为 207，详情看 error。

### 9.40 市场维度 perp|spot + 现货交易 + 基差(2026-09-21)

设计稿 `docs/design/spot-market-2026-09-21.md`。`Market = 'perp'|'spot'`,所有旧数据与不带该字段的请求按 `perp` 解释。价格/数量为十进制字符串,时间为 unix 毫秒。

**类型增量**(新增字段一律有默认值,老网关返回时前端按 perp 兜底):

- `Workflow`:`markets: Market[]`(默认 `['perp']`)、`default_market: Market`(默认 `'perp'`)。POST `/api/workflow` 接受部分更新;`default_market` 不在 `markets` 内 → 400 `default_market_not_enabled`。
- `StrategyThread`:`market: Market`、`pair_id: string|null`(本轮恒 null)。spot 线程 `side` 恒 `'long'`、`leverage` 恒 1、`margin_mode` 占位 `'cross'`、`margin_usdt` = 实际花费 USDT。
- `PositionView` / `OpenOrderView`:`market: Market`。spot 持仓 `side:'long'`、`leverage:1`、`mark_price` = 现货最新价;`entry_price` 算不出成本时等于 mark 且 `AccountView.note` 说明。
- `MarketView`:`market: Market`;spot 下 `funding_rate:'0'`、`next_funding_at:0`、`open_interest:'0'`。
- `ManualOrderRequest`:`market?: Market`。spot:`side` 必须 `'long'`(否则 400 `spot_no_short`),`action:'open'` = 买入、`'close'` = 卖出全部或 `qty`;`margin_usdt` = 花费 USDT;`leverage/margin_mode` 忽略。
- `Proposal`(agent 提案)可选 `market`,spot 只许 `direction:'long'`,违反 → 校验失败 `spot_no_short`;`market` 不在 `workflow.markets` → 闸拒 `market_not_enabled`。
- `ExecutionView.okx` 增:`acct_lv: 1|2|3|4|null`、`acct_lv_label: string|null`(中文:简单模式/单币种保证金/跨币种保证金/组合保证金)、`markets_available: Market[]`、`spot_holdings: {ccy:string; total:string; available:string; usdt_value:string|null}[]`(仅 okx 通道,读不到为 `[]`)。
- `ExecutionView.markets_supported: Market[]`(当前通道支持的市场;paper `['perp','spot']`,binance 四通道 `['perp']`,okx 按 acctLv:1 → `['spot']`,≥2 → `['perp','spot']`)。
- 保护自检:`ProtectionStatus` 按 `(channel, symbol, market)` 计;`POST /api/execution/verify-protection` body `{symbol?, market?}`(默认 perp);`GET /api/execution/protection` 每条记录带 `market`。
- 前置拒绝:perp 不在 `markets_supported` 时任何 perp 下单(手工/agent/自检)直接 `local_reject`,`error` 为 `perp_unavailable_account_mode`,事件文案「OKX 账户处于简单模式,永续不可用;请在 OKX 网页/App 切换到单币种保证金模式」,不再出现裸 51010。
- `GET /api/symbols?market=spot|perp`(缺省 perp)返回该市场可交易列表。
- 结算(`SettlementView`)spot 下 `funding: null`;`realized_pnl` 由线程按买卖成交算。

**基差**:`GET /api/market/basis?symbol=BTCUSDT`

```json
{"symbol":"BTCUSDT","spot_last":"64010.5","perp_mark":"64052.1","perp_last":"64050.0","basis":"41.6","basis_pct":"0.065","funding_rate":"0.0001","funding_interval_ms":28800000,"funding_annualized_pct":"10.95","next_funding_at":1758470400000,"as_of":1758460000000}
```

spot 或 perp 任一侧拉不到 → 404 `basis_unavailable`,body `{error, missing:'spot'|'perp'}`。缓存 10 秒。

**ASP 套利信号(仅记录)**:入站信号识别为套利时,信号行 `kind:'arbitrage'`,附 `arbitrage: {symbol, spot_side:'long', perp_side:'short', basis_pct: string|null, expected_apr: string|null}`,`reason:'arbitrage_recorded_only'`,不产生意图。

**事件**:所有涉及市场的事件文案前缀 `[spot]` / `[perp]`;`events` 行加 `market: Market|null`。

**账户模式(2026-09-21 追加)**:
- `POST /api/execution/okx/account-level/refresh`,无 body → `ExecutionView`(网关重读 `okx account config` 的 acctLv,只读;非 okx 通道 409 `not_applicable`;读不到 502 `okx_config_unreadable`)。用于用户在 OKX 网页切完模式后前端轮询。
- `POST /api/execution/okx/account-level`,body `{acctLv: 1|2|3|4, force?: boolean}` → `{ok:true, acct_lv, execution: ExecutionView}`。网关按当前 profile 本地签名直打 OKX `set-account-level`(CLI 无此命令;「不读 key」边界的第二个明确例外,只在该调用内读 `~/.okx/config.toml`,不落日志不回显)。有永续持仓/挂单且未 `force` → 409 `account_not_flat`(现货持币不算);OKX 拒绝 → 409 `okx_<code>`,message 为中文解释(51070 = 从简单模式首次切出须在网页/App 做测评);参数错 400 `bad_acct_lv`。成功后 `ExecutionView.okx.acct_lv / markets_available / markets_supported` 已刷新。

### 9.41 研究工作台(Horizon 式 A/B/C 回放,2026-09-21)

后端由 astra 交付(`docs/research/architecture-and-evaluation.md`、`docs/research/claude-frontend-handoff.md`,提交 0238af9 的补丁已合入);前端页 `#/research`(`packages/webui/src/pages/research.tsx`),侧栏「回顾 · 研究工作台」。所有接口前缀 `/api/research`,复用网关端口与 Vite proxy;**只读 + 发起实验,没有任何交易所写入口**。比例一律小数(0.02 = 2%),价格/金额/数量十进制字符串;前端只在展示时格式化。

**对象链**:`Dataset → Study → Policy → RunManifest → Job → Result → Decision/Trade → Draft → ChildRun`。改数据 / 策略 / 成本 / 区间 / 模型任一项 = 新 run,前端不在旧图上改标题。臂 id 形如 `a_rules:0` / `b_agent:1` / `c_filter:0`,A 只跑一次作共同基准,repeat 不能合成组合。

**接口**(完整表见 handoff §3):`GET capabilities|schema|datasets|runs|runs/:id|runs/:id/result|runs/:id/events?after=|runs/:id/evidence?offset=|runs/:id/export|studies/:id`;`POST datasets|studies|estimate|runs(202)|runs/:id/cancel|runs/:id/replay|tools|chat`。**Claude 追加**:`POST /api/research/datasets/from-market` body `{symbol, timeframe:'15m'|'1h'|'4h'|'1d', from_ms, to_ms}` → 201 `{id, bars, symbol, timeframe, first_at, last_at}`,从当前行情通道(OKX)拉**现货**已收盘 K 线冻结成 dataset,`source` 写成 `okx:spot:1h:market/candles+history-candles`,`available_at = close_time`;超 50,000 根 → `range_exceeds_50000_bars`,不足 10 根 → `too_few_bars`。

**注册顺序**:`researchRoutes` 必须排在 `eventRoutes` 之前(后者有老的 `/api/research/:id` 信息员研究任务路由,先注册先匹配)。

**SSE**:`/api/events` 增 `research.workbench`,data `{seq, run_id, at, event, data}`,event ∈ queued|running|progress|cancelling|completed|failed|cancelled|budget_exhausted|interrupted。App.tsx 把 `progress` 写进 `['research','progress',run_id]`,其余事件失效 `['research','runs']` / `['research','run',id]` / `['research','result',id]`。断线用 `runs/:id/events?after=<seq>` 补,seq 来自数据库。running 时页面另有 2s 轮询兜底。

**状态机**:`queued → running → completed | failed | budget_exhausted | cancelling → cancelled`;进程重启时未完成的 → `interrupted`。只有 `completed` 展示 A/B/C 比较与候选评估;其它终态最多显示「部分结果」。`completed` 只表示算完了,不表示策略有效。

**前端 Study 切法**(抽屉第 2 步):按 dataset 的 bar 网格切,边界都落在真实 `close_time`(`first_at + k*timeframe_ms`);`warmup = max(lookback, atr_period)+2`,`purge_bars = max(holding_bars, 12)`,development / validation / holdout 默认 60/20/20,段间空 `purge_bars+1` 根;`study.id` 由 dataset id 前缀 + warmup + purge + 比例拼成,内容相同则幂等。候选实验(带 `parent_run_id`)沿用父实验的 study / 执行设置 / 大脑;`holdout` 跑完即封存(`study_sealed_after_holdout`)。

**页面元素**:左栏研究代理对话(工具步骤按轮展开,失败步骤红点;代理发起的实验自动选中)+ 实验列表;右栏策略卡(名称 / 描述 / policy hash / dataset hash / 来源策略 / 大脑 / 引擎 / 窗口;取消 / 重放核验 / 导出 / 下一次实验)+ 分页:概览(臂切换 + 指标条 + 权益/回撤/敞口图 + 成本 + 配对比较 + 数据与证据标签)、交易(按退出批次)、决策与差异(点行定位图表)、候选评估(follow/skip 对照、同参与率随机对照标「探索性」、重复一致率)、证据(recordings / model_calls 分页)、实验设置(冻结的全部参数 + B 的原策略 + playbook)。空值口径:`win_rate/daily_sharpe = null` → 「样本不足」,`profit_factor = null` → 「不可得」,估价 `price = null` → 「未知」而不是 $0。

**幂等**:抽屉打开时生成一个 `idempotency_key`,同 key 重试复用,改请求换 key;`idempotency_conflict`(409)时前端自动换 key 并提示重点;`research_busy:<id>` 提示已有实验。

**§9.41 第二轮追加(2026-09-21 下午)**:后端接口见 `docs/research/claude-frontend-handoff.md`「第二轮接口」与 `round2-report.md`。前端:左栏实验列表上方两个入口切换右栏视图——「宇宙筛选」(`components/research-workbench/screen-panel.tsx`:冻结多币宇宙 → `GET /universes/:id/screen`,β/α/R²/α 占比/raw 与残差指标/趋势/名次,可排序,一键带进新实验)与「策略构建」(`strategy-builder.tsx`:自然语言 → `POST /strategies/compile` → IR + 六项检查 + unmapped;IR JSON 可改后零模型重检;原语目录侧栏;检查全过才允许「用这条策略新建实验」)。实验详情新增「诊断」分页(`diagnostics.tsx`:出场原因、R 直方图、MAE/MFE、成本占比、因子归因、分币贡献、父子逐段消融 `GET /runs/:id/attribution`;老 run 无 diagnostics 时前端按交易表兜底并明示)。新建实验抽屉:数据源单资产/多资产宇宙(`max_positions`、`allocation`),策略预置模板/IR,`model_call_timeout_ms`(秒输入,10–300),同 study 再跑或候选实验必须勾适应性搜索确认(`adaptive_search_ack_required`)。深链 `#research?run=<id>`。宇宙的 study 用 universe id 当 `dataset_id`,边界取自 `aligned_close_times`。

### 9.42 盈亏比硬门改成「先放置再判定」+ 日线结构方向门(2026-09-21 晚)

**为什么**:第三轮 `d5339064`(SOL 1h)硬门把 7 个候选全拦(止损太窄 ×6、单笔风险超限 ×1),三臂 0 笔。Jacky 拍板:这是流程错误不是策略错误——策略出止损时根本不知道成本,事后拦等于把所有 1h 策略判死;正确的流程是**候选出现时代码先把止盈止损放到合理位置,门只拦结构真没空间的**。回测与实盘同一份代码(`research/order-gate.ts`)。

**后端语义**(`fitOrderGate` → `evaluateOrderGate`):
- 止损:策略给的结构位 / ATR 止损,但不得窄于成本下限 `min_stop_cost_multiple × 往返成本`;`stop_floor='widen'`(默认)放宽到下限并标 `fit.stop_source='cost_floor'`,`'block'` 保留旧行为直接拦。
- 止盈:策略给的结构目标(上方阻力块下沿)原样用;固定 R 目标(`fixed_r_target` / 旧 policy 的 `take_profit_r`)**按放置后的止损重算**;没有目标时按 `target_fallback_r × 止损距离` 补(默认 2,`null` 才判 `no_target`)。
- 结构目标离入场太近(rr < min_rr)仍然拦:那是策略该放弃的位置,诊断里文案「结构没空间」。
- `unit_notional` 已剔除仓位因素,默认不套单笔风险上限(`risk_cap_sizing='risk_fraction_only'`;`'all'` 恢复旧行为)。
- 成交时按实际 next-open 价再放置一次(跳空会改变止损距离)。
- **兼容**:只有冻结请求的 `order_gate` 带 `stop_floor` 字段才启用放置层;旧 manifest 重放沿用记录时的只拦不放,哈希不变。前端每次请求必须发全七个字段。

**契约增量**:`OrderGateParams` +`stop_floor` / `target_fallback_r` / `risk_cap_sizing`(可选);`ResearchEntry` / `ResearchDecision` / `ResearchTrade` +`fit:{stop_source,target_source,strategy_stop,strategy_target,stop_pct,target_pct,rr,floor_pct}`,`ResearchTrade` +`stop` / `target`(放置后的价位);`diagnostics.gate_stats` +`passed` / `adjusted:{stop_widened,target_fallback}`;`StrategyCompileRequest` +`dataset_id` / `execution` / `order_gate`,`StrategyCompileResult` +`constraints:{symbol,timeframe,round_trip_cost_pct,stop_floor_pct,min_rr,atr_pct_median,min_atr_multiple,strategy_stop_pct_median,stop_fit_rate,note}`(编译提示里同一段文字喂给模型:成本、止损下限、最小盈亏比、本数据集 ATR 中位与折算的最低 ATR 倍数);precheck 新项 `stop_fit_rate`(候选止损被放宽比例,阈值 `thresholds.max_stop_fit_rate` 默认 0.5,超过说明策略自己的止损在本周期几乎不起作用);新原语 `htf_structure_regime`(regime:已收盘高周期最近 BOS 向上且价格离上方阻力块位置 ≤ `max_position`,默认 1d / 0.7),把「日线结构决定方向,小周期只在允许的方向和位置交易」接成真正的方向门(此前 `bos_direction` 只当证据展示,没人消费)。

**页面**:抽屉「盈亏比硬门」三个新控件 + 一行流程说明;交易表止损/止盈列带来源徽标(成本下限 / 结构 / 固定倍数)与 RR;决策行内联放置摘要;诊断的硬门块改成通过 / 放宽后通过 / 拦下(按原因中文)的堆叠条;策略构建的编译结果多一条「设计约束」;体检多一项「止损放宽比例」。

### 9.43 策略规范 Strategy Spec v1 + 每笔期望单位修复 + Horizon 式研究页 P0(2026-09-22)

**为什么**:交接包 `horizon-claude-handoff-2026-09-22`(Codex 产出,Horizon 对标)P0:研究页从实验控制台改成「问题 → 答案」;两处可疑经代码证实——`每笔期望 -143.15%` 是 `engine.ts` 乘了 100 前端再乘 100;诊断文案因果过强。另外「策略有效性」的根因:成本/盈亏比/ATR 约束只喂给 compile,B/C/研究代理不知道。

**后端契约增量**(`packages/contracts/schema/research.json`):
- `ResearchMetrics.expectancy_pct` / `per_trade_return_pct.{avg,median,std,best,worst}` / `trade_return_histogram.bins` 改为小数(0.0143 = 1.43%)。**旧 run 存的仍是百分数**,前端按 `manifest.request.spec_version` 缺失判旧口径(÷100,标「旧口径」)。
- `ResearchRequest` +`spec_version?`(`store.create` 自动盖 `'strategy-spec/v1'`,前端不用传);旧 manifest 缺字段 → 重放行为与哈希不变。
- `StrategyCompileResult` +`spec: StrategySpecReport {version, ok, violations[{code, severity:'block'|'warn', message, field?}], text}` +`rules[{category, primitive, text, optional?}]`(可读规则卡,一条一句中文,参数已人话化)。`POST /strategies/compile` 只带 `ir`(不带 `text`)是零模型,可给任意 run 的 IR 拿 rules/spec/constraints。
- `ResearchDecision` +`spec_violations?: string[]`(仅 B 臂、仅 `spec_version` run):proposal 放置前的原始止损/止盈违反的条款 code。
- 研究代理工具 `policy.draft` / `experiments.run_candidate`:候选 IR 有 block 违规 → `strategy_spec_violation:<codes>`;草稿返回多 `spec`。

**规范本身**见 `docs/research/strategy-spec.md`;代码 `research/strategy-spec.ts`(`specText` / `checkIRSpec` / `checkProposalSpec`),接入 `strategy.ts`(compile prompt + 结果)、`agent.ts`(B/C prompt)、`engine.ts`(决策行)、`service.ts`(按 run 数据集实例化)、`tools.ts`(研究代理 prompt + 草稿门)。测试 `strategy-spec.test.ts` 6 条(含旧/新 run 决策哈希对照)。

**页面(P0,前端)**:布局状态机 `chat_only → chat_with_artifact`,对话默认单栏,结果面板可关可开(关闭保留 run/tab/滚动),实验列表折成历史抽屉;空态「你想研究什么?」三入口(研究一个资产 / 比较资产 → 资产筛选;验证一个想法 → 策略构建;杠杆/资金费数据本版没有要明说);答案层 = 问题式标题 + 一句代码生成的结论(<10 笔:「不足以判断规则是否稳定」)+ 三张证据卡(区间收益 / 最大回撤 / 样本数)+ 权益主图 + 两个下一步;原七个 tab 全部保留进「高级」,hash/引擎/大脑进「方法与复现」;策略卡先显示 rules 规则卡,IR JSON 折叠;compile 的 spec 违规按 block/warn 列出,block 时禁用「用这条策略新建实验」;诊断四条 foot 文案改成「观察 → 假设 → 验证」;决策行 `spec_violations` 徽标;零决策记录写「此轮按固定规则执行,没有模型决策记录」。默认隐藏 ≠ 删除。

### 9.44 研究会话与研究 loop(自然语言研究工作台,2026-09-22 晚)

**为什么**:交接包 `horizon-claude-handoff-2026-09-22-v1.2`(CLAUDE_HANDOFF / 08 / 09)要的不是实验控制台改版,而是「提问 → 系统定任务与计划 → 真调工具 → 有来源的图表/表格/结论 → 追问 → 刷新后恢复」。现有 `POST /api/research/chat` 是模型在沙箱里写脚本分析一个已跑完的 run,不能回答市场问题。§9.41–9.43 的实验、策略构建、资产筛选全部保留为高级入口;本节新增一套独立的领域对象,不改旧表、不迁移旧数据。

#### 对象链

`Session(会话) → Message(消息,blocks) → Inquiry(一次提问的研究 run) → Step(步骤,绑工具调用) → Snapshot(数据快照,不可变) → Artifact(产物:图/表/报告,引用快照) → Claim(结论,引用产物/指标)`。**Inquiry ≠ 回测 run(`research_runs`)≠ 策略版本**:策略验证类提问在某一步调用 `run_backtest` 时会创建一个普通回测 run 并在 step 里引用它的 id,回测结果仍走 §9.41 的接口。

#### 表(迁移 `0029_research_sessions.sql`,全部新表,`research_artifacts` 只加列)

- `research_sessions(id, title, created_at, updated_at, context_json)`:context = 当前选中引用 `{instrument_refs[], selected_artifact_id?, selected_inquiry_id?, selected_run_id?, selected_window?{from_ms,to_ms}}`。
- `research_messages(id, session_id, seq, role 'user'|'assistant', created_at, blocks_json, inquiry_id?)`。
- `research_inquiries(id, session_id, user_message_id, task_kind, status, question, plan_json, budget_json, usage_json, checkpoint_json, error_code?, error?, created_at, updated_at, idempotency_key UNIQUE)`。
- `research_steps(id, inquiry_id, seq, parent_id?, title, tool, tool_version, status, input_json, output_summary_json, snapshot_refs_json, artifact_refs_json, error_code?, retryable, started_at?, ended_at?, usage_json)`。
- `research_inquiry_events(seq AUTOINCREMENT, inquiry_id, at, event, data_json)`。
- `research_snapshots(id, kind, provider, instrument_json, requested_window_json, actual_window_json, as_of, fetched_at, frequency?, units_json, coverage, quality_flags_json, rows_json, checksum, method_version)`。
- `research_artifacts` +`inquiry_id?`, `snapshot_refs_json?`, `data_kind?`('observed'|'derived'|'estimated'|'synthetic'), `availability?`, `question?`, `spec_json?`(chartSpec/tableSpec),`caption?`;旧行这些列为 NULL,读时按 legacy 处理。

#### 状态机

Inquiry:`queued → planning → running → validating → completed`;旁路 `awaiting_input`(计划缺关键条件,等用户答)、`cancelling → cancelled`、`failed`、`incomplete`(预算/额度耗尽或部分步骤失败但已有产物;**不是完成**)。进程重启时未终态的 → `incomplete`(error_code `interrupted`)。Step:`pending → running → succeeded | failed | skipped | cancelled`。

#### 任务类型与路由

`task_kind ∈ 'market'(解释一个资产的现象)| 'compare'(多资产相对表现)| 'validate'(策略想法 → 编译/回测/对比持有)| 'diagnose'(围绕选中回测 run 追问)`。规划器(一次模型调用)输出 `{task_kind, instruments[], window, timeframe, plan:[{key, title, tool, args, depends_on[]}], clarify?:string}`;**市场/比较类不得包含 run_backtest / compile 步骤**;`clarify` 非空 → 状态 `awaiting_input`,不跑任何付费步骤。模型不可用或输出不合法 → 用确定性规则路由(关键词 + 默认计划),`plan_json.source='fallback_rules'`。

#### 工具合同(`ToolDefinition`,registry 在 `research/loop/tools.ts`)

```ts
interface ToolDefinition<I,O> {
  name: string; version: string;                       // 'get_funding_history' / '1'
  task_kinds: TaskKind[]; asset_classes: ('crypto'|'equity')[];
  access: 'read' | 'compute' | 'create_run';           // create_run 只有 run_backtest
  budget_class: 'none' | 'data_call' | 'model_call' | 'backtest';
  timeout_ms: number; idempotent: boolean; cancellable: boolean;
  input: JSONSchema; output: JSONSchema;               // 运行时 ajv 校验,不靠 TS 类型
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
interface ToolResult<O> { status:'ok'|'partial'|'missing'|'not_applicable'|'stale'|'error'; output: O|null;
  snapshot_refs: string[]; artifact_refs: string[]; coverage?: Coverage; warnings: string[]; units?: Record<string,string>;
  error_code?: 'UNSUPPORTED_ASSET'|'DATA_MISSING'|'DATA_STALE'|'RATE_LIMIT'|'BUDGET_EXHAUSTED'|'PROVIDER_ERROR'|'SCHEMA_MISMATCH'|'UNIT_MISMATCH'|'NOT_COMPARABLE'|'CANCELLED'|'TIMEOUT'; retryable?: boolean; latency_ms: number; }
interface ToolContext { inquiry_id: string; step_id: string; signal: AbortSignal; store: LoopStore; budget: Budget; brain?: Brain; now(): number; }
```

v1 工具(名字固定,前端按名字翻步骤标题):

| 工具 | access | 输入要点 | 输出 / 快照 | 备注 |
|---|---|---|---|---|
| `resolve_instruments` | read | `{query?:string, symbols?:string[], market?:'spot'\|'perp'}` | `instruments[{canonical_id:'okx:spot:BTC-USDT'\|'okx:perp:BTC-USDT-SWAP', asset_class:'crypto', venue:'okx', market_type, base, quote, timezone:'UTC'}]` | 只认 OKX 在售;股票 → `UNSUPPORTED_ASSET`(接口留着) |
| `inspect_data_coverage` | read | `{instrument, metric:'price'\|'funding'\|'open_interest'\|'liquidations'\|'liquidation_estimates'\|'orderbook', window}` | `{availability:'available'\|'partial'\|'missing'\|'not_applicable', earliest?, latest?, note}` | 现货问 funding → not_applicable;liquidation_estimates 一律 missing |
| `get_price_history` | read | `{instrument, timeframe, window}` | 快照 kind `price`(OHLCV,已收盘) | 复用 `CcxtMarket.fetchKlines` / 现有 from-market 路径 |
| `get_funding_history` | read | `{instrument(perp), window}` | 快照 kind `funding`:`rows[{ts, rate(fraction/period), interval_ms:28800000}]`,units `{rate:'fraction_per_8h'}` | **不自动年化**;`settled` 与 `next_predicted` 分字段,后者 v1 不取 |
| `get_open_interest` | read | `{instrument(perp), timeframe, window}` | 快照 kind `open_interest`:`rows[{ts, oi_contracts?, oi_value_usd}]` | ccxt `fetchOpenInterestHistory` |
| `get_liquidations` | read | `{instrument(perp), window}` | 快照 kind `liquidations`:`rows[{ts, side, pos_side, size, price}]`,coverage `partial`(OKX 公共接口只给最近 ≤100 条) | 真实已发生清算;窗口内 0 条 = 「已接数据,窗口内未记录」 |
| `get_liquidation_estimates` | read | 同上 | 固定 `status:'missing'`,`error_code:'DATA_MISSING'`,note「估计数据源尚未接入」 | **不得**用 OHLC/成交量/订单簿伪造热图 |
| `analyze_relative_strength` | compute | `{instruments[], benchmark:'okx:spot:BTC-USDT', timeframe, window}` | 表产物:每资产 `{return, beta, alpha_annualized, residual_sharpe, max_dd, coverage}` | 复用 `factor.ts` OLS;样本 < 30 根 → 行状态 `insufficient` |
| `analyze_leverage` | compute | `{price_snapshot, funding_snapshot?, oi_snapshot?}` | 派生指标 `{price_change, oi_change, funding_avg, funding_pctile_vs_window, observation}` + 一张三轴对齐的图 | 只产出「观察」,不产出「因此会跌」 |
| `compare_buy_and_hold` | compute | `{run_id, arm}` | `{strategy_net_return, buy_and_hold_return, window, comparable:true}` + 表 | 同窗口、同数据集、同费率一次进出的持有 |
| `compile_strategy` / `run_backtest` | compute / create_run | 复用 §9.41 compile 与 `POST /runs`(含 study 自动切段) | step 引用 `run_id`,回测结果仍走旧接口 | 只在 validate 任务;预算类 `backtest`;幂等键 = inquiry_id+step key |
| `render_artifact` | compute | `{kind:'chart'\|'table', spec, snapshot_refs[], title, question}` | artifact id | spec 受控:`type ∈ line\|bar\|candlestick\|table\|comparison`,字段必须存在于引用快照 |
| `compose_answer` | model | `{question, steps summary, artifact ids, metrics}` | assistant blocks | 只能引用存在的 artifact/metric id;非法引用剥掉;模型不可用 → 代码模板生成 |

#### 事件(SSE `research.inquiry`,data `{seq, inquiry_id, session_id, at, event, data}`)

`inquiry.queued | inquiry.planning | inquiry.plan(data=plan) | inquiry.awaiting_input | step.started | step.progress | step.completed(data 含 status/snapshot_refs/artifact_refs/summary) | artifact.created(data=artifact 摘要) | usage.updated | inquiry.completed | inquiry.incomplete | inquiry.failed | inquiry.cancelled`。`GET /inquiries/:id/events?after=<seq>` 按 seq 补发;前端按 seq 去重;artifact.created 引用不可变产物,不重复生成卡片。

#### 接口(前缀 `/api/research`)

- `POST /sessions` `{title?}` → 201 Session;`GET /sessions?limit=` → `{items[]}`(按 updated_at 倒序);`GET /sessions/:id` → `{session, messages[], inquiries[](含 steps), artifacts[]}`(**恢复历史只靠这一个接口**);`PATCH /sessions/:id/context` 更新选中引用。
- `POST /sessions/:id/messages` `{text, idempotency_key, context?}` → 202 `{message, inquiry}`(用户消息落库 + inquiry queued);同 idempotency_key 重发返回同一 inquiry,**不重跑**。会话已有未终态 inquiry → 409 `research_session_busy`。
- `POST /inquiries/:id/answer` `{text}`(回答 awaiting_input)→ 继续;`POST /inquiries/:id/cancel` → `{status:'cancelling'}`;`GET /inquiries/:id` → inquiry + steps。
- `GET /artifacts/:id` 现有接口扩展返回 `{..., inquiry_id, snapshot_refs, data_kind, availability, spec, caption}`;`GET /snapshots/:id` → 快照元信息 + rows(`?rows=0` 只给元信息)。
- `GET /tools` → 工具目录(name/version/task_kinds/asset_classes/input schema),给前端翻标题与开发详情。

#### 消息 blocks(`blocks_json`)

`{kind:'text', text}` / `{kind:'plan', task_kind, steps:[{key,title,tool,status}]}` / `{kind:'step_ref', step_id}` / `{kind:'chart_ref'|'table_ref'|'report_ref', artifact_id}` / `{kind:'strategy_ref', run_id}` / `{kind:'comparison_ref', artifact_id}` / `{kind:'data_gap', metric, availability, note}` / `{kind:'run_status', inquiry_id, status}` / `{kind:'next_question', text}`。旧 `research_chats` 记录不转换,前端在会话列表下面单独一组「旧对话(只读)」。

#### 预算与取消

`budget_json = {max_model_calls:4, max_data_calls:12, max_backtests:1, wall_clock_ms:600000}`,`usage_json` 同形状 + `unknown_cost:true|false`。规划前估算,调用前检查,调用后记账;重试计预算;连续同一 error_code 两次停止。取消:AbortSignal 传到工具;无法立即停的回测继续查状态但不再跑下游步骤,状态 `cancelling` 直到工具返回。刷新/重连只读 `GET /sessions/:id` + events 补发,不产生新调用。

#### 前端(`#research`)

会话优先:左侧会话列表(可折叠),中间对话渲染 blocks(计划可展开步骤,步骤只显示目的+状态,展开看数据范围/来源/摘要/耗时;开发详情才显示 tool 名与参数),图/表卡片就地渲染并可打开到右侧结果面板(`chat_only → chat_with_artifact`,关闭不丢选中);追问时把当前选中 artifact/inquiry/run/窗口写进 session context 随消息发送;缺数据块显示「本版未接入」而不是空图;`incomplete` 显示已有产物 + 停止原因;旧实验页、策略构建、资产筛选作为「高级」入口保留。

#### 验收(本节)

1 提问「BTC 这轮上涨有没有伴随杠杆升温?」→ 计划含 price/funding/oi/liquidations 四步 → 真数据快照 → 一张对齐图 + 观察文字 + 缺数据块(清算热图未接);2 关闭结果面板再打开仍是同一 artifact 与滚动;3 追问「这段 OI 变化怎么解释」引用同一快照不重新取数(step 显示 `snapshot reused`);4 刷新页面从 `GET /sessions/:id` 完整恢复,不新增任何 inquiry/model call;5 取消进行中的 inquiry 后已完成步骤与产物仍可看;6 现货问 funding 得到 `not_applicable`;7 `validate` 提问走 compile → precheck → 回测 → 对比持有,零交易时明说没有交易而不是宣称高胜率;8 旧 `#research?run=` 深链、七个 tab、策略构建、资产筛选全部仍可用。

### 9.46 全窗口多资产回测报告 / 策略对象生命周期 / 订单周期与永续 / 独立 Pine 引擎(2026-09-23)

契约源:`packages/contracts/schema/research-backtest.json`(BacktestReport、BacktestAsset、BacktestMetrics、BacktestScore…)、`research-strategy.json`(ResearchStrategy、Version、Detail、Transition…)、`research-orders.json`(BacktestPlan、BacktestReplay、BacktestPlanStats)。比例一律小数(0.0143 = 1.43%),max_drawdown 为正数小数、界面显示为红色负数。

**回测口径变化**:研究 loop 的 run_backtest 不再只跑开发段(旧口径 6.6 年日线只回测到 2022),改为预热后到最新已收盘 K 线的全窗口;样本内(前 70%)/样本外(后 30%)只做分段标注与分段指标。同一 inquiry 的多个回测共用同一窗口与分段(持有基准一致)。默认资产 = 主资产 + BTCUSDT + ETHUSDT + 等资金篮子 BTC+ETH;每个资产带买入持有基准(equity 点里的 benchmark_pct)。验证类问题默认回看:日线 3000 天、4h 2190 天、1h 730 天(`loop/planner.ts validateDays`)。评分 BacktestScore 0–100,confidence 按成交笔数(<10 low、<30 medium)。

**订单周期**:StrategyIR 可选 `order` 块(方向 long|short|both、市场 spot|perp、杠杆、入场 market|limit + 限价来源 + 时效、多档止盈来源(缺省压力位)、止损沿用 risk.stop(缺省支撑破位)、min_rr 硬约束、on_new_signal {unfilled: replace|keep, filled: roll|add|ignore}、max_holding_bars)。语义对齐 8794 影子回放 v11:限价时效内触价才成交否则 no_fill;跳空按 open 成交并钳制;同根 SL/TP 判 SL;未成交同向新信号整计划替换、已成交结转(rolled)或加仓。永续:做空、杠杆、按标记价强平、资金费(OKX 官方 → OKX 月度归档 → 2022 前币安代理并标注)。

**接口**(前缀 `/api/research`):
- `GET /backtests/:id` → BacktestReport;`GET /backtests?strategy_id=&limit=` → `{reports: BacktestReportSummary[]}`;`POST /backtests {strategy_ir, timeframe, symbols?, from_ms?, to_ms?, title?}` → `{report_id}`(同步)。
- `GET /backtests/:id/replay?asset=&from_ms=&to_ms=` → BacktestReplay(candles ≤5000,超出标 truncated)。
- `GET /strategies?q=&filter=all|live|watchlist|alerts|archived&sort=updated|return|sharpe|name` → ResearchStrategyList;`POST /strategies` → 201 ResearchStrategy;`GET /strategies/:id[?report=]` → ResearchStrategyDetail;`PATCH /strategies/:id`;`POST /strategies/:id/transition {to, confirm?}`(paper→live 需 `confirm:'LIVE'`,非法转移 409 `strategy_transition_conflict:*`);`POST /strategies/:id/versions`;`POST /strategies/:id/backtest` → `{report_id}`;`POST /strategies/:id/attach-session {session_id}`;`DELETE /strategies/:id` = 归档。paper/live/published 本轮只记录状态,不接交易所写入口;`lab_strategy_id` / `published_listing_id` 是给 lab 策略库与 ASP 发布留的挂点。
- 回测报告落库后广播(`research/hooks.ts emitBacktestReport`),策略服务按 ir_hash → 会话绑定草稿 → 会话同名 → 新建 的顺序自动挂链。
- `GET /pine/health` → `{status: up|starting|down|disabled, pid, port, restarts, last_error, engine, version, scripts, admitted}`;capabilities 带 `pine` 与 `pine_admission:'pine_admission_v2'`。

**Pine 引擎**:`packages/pine-engine`(AGPL-3.0,进程边界隔离),网关启动时托管子进程(临时端口、崩溃退避重启、心跳看门狗、随网关退出),Node `--permission` + 进程内加固沙箱;`TG_PINE_ENGINE=0` 关闭,`TG_PINE_PORT` 指定端口。不再有 8793 手动 sidecar。准入 v2:合成 + 真实行情两套数据各过因果/确定性/有输出/预热四关;inputs_schema 校验。

**前端**:`#my-strategies`(卡片列表,搜索/筛选/排序/网格列表)、`#my-strategies?id=<id>[&report=]`(详情:生命周期步进条 + Horizon 式报告)、`#backtest?id=<report_id>`(单份报告);报告组件 `components/backtest-report`(概览/表现/交易分析/交易列表/策略回放 五个 tab,BTC/ETH/BTC+ETH 切换与叠加)。研究页右栏新增「Pine 目录」视图;对话里 find_data_source 步骤展开显示数据来源卡,回答末尾显示概念覆盖段;`#research?strategy_id=<id>&new=1` 开新会话并绑定草稿策略,`&session=<id>` 恢复会话。

### 9.47 StrategyBinding 编译 + 内置策略导入 + 策略库并进「我的策略」(2026-09-23)

契约源:`packages/contracts/schema/research-binding.json`(StrategyBinding、BindingRoleSlice、BindingRule、BindingUnmapped、StrategyBindingResponse、BuiltinImportResult)。规范依据:`docs/design/strategy-apply-spec-2026-09-23.md` §3(含 Codex 复审修订);合并计划:`docs/research/strategy-merge-plan-2026-09-23.md`。**字段名定稿后保持稳定**,实盘侧(radar 唤醒、候选生成、holding-policy、gates)按这里消费。本节只有只读编译与研究台内导入,**没有**写实盘注册表的 apply 接口(等 Jacky 放行后由实盘侧做)。

**接口**(前缀 `/api/research/strategies`):
- `GET /:id/binding[?version=]` → `StrategyBindingResponse {strategy_id, version, lab_strategy_id, binding: StrategyBinding|null, unmapped}`。缺省当前版本;没有 IR(规则未编码的导入草稿)时 `binding=null`、`version=null`,`unmapped` 说明缺什么。版本不存在 404,version 非正整数 400。不落库、不下发。
- `POST /import-builtin {backtest?: boolean, ids?: string[]}` → `BuiltinImportResult {items: [{builtin_id, strategy_id, created, version, translation: full|partial|none, report_id, error}]}`。幂等键 `origin.source='import'` + `lab_strategy_id=<内置 id>`(不含归档);已存在不新建,IR 译文变了才加新版本;`backtest=true` 只对「当前版本还没有完成报告」的跑一次全窗口回测(同步)。未知字段 / 未知 id 400。只写研究台表。

**StrategyBinding 字段**(schema_version `strategy-binding/v1`):
- 身份与版本:`strategy_id / version / ir_hash / content_hash`(不含 compiled_at)`/ compiled_at / compiler_version / libs {primitive_registry 指纹, order_gate: structure|legacy, strategy_spec, horizon_policy}`。
- 周期与市场:`horizon`(intraday|swing|position;1m/3m/5m=scalp 为 null 且 block)`/ timeframe / confirm_timeframe`(HORIZON_POLICY)`/ symbol / market / direction`。
- `trigger {primitives, regime, short_primitives, short_regime, eval_on:'bar_close', cooldown_bars:null}`:同一根 AND,上升沿算新信号;不另设冷却,同向新信号按 `entry.on_new_signal`。
- `evidence_plan {indicators[{id, indicator, args, output, timeframe, from[]}], structure[], info_topics[]}`:由 IR 原语输入推导,不手填(替代策略库的 EvidenceEditor)。
- `entry {type, price, expiry_bars, on_new_signal{unfilled, filled}, max_adds, chase_atr_max:null}`;`stop {primitive, buffer_atr, is_invalidation:true, min_stop_atr}`;`targets[{source, size_pct, kind: chart|indicator|r_multiple}]`;`target_policy: chart|user_r|signal_exit|trail_only`;`trail / breakeven_after_tp / breakeven_after_r / max_holding_bars / signal_exits[]`;`min_rr`(只有用户硬约束 order.min_rr 才有值)。**几何口径不自定**:订单门取 `order-gate.ts orderGateFor(ir, DEFAULT_ORDER_GATE)`(结构口径:止损离入场 < min_stop_atr×ATR14 不做、盈亏比只展示、止盈只取图上价位算不出就不设),止盈/时效/结转缺省取 `orders/intents.ts resolveOrder`(研究回放同一个函数;无 order 块的 IR 按现货做多解析)。
- `risk {sizing, leverage, leverage_cap: 20, max_risk_fraction}`;部署模式与仓位 cap **不在绑定里**(属于部署)。
- `model {entry_filter: on|off, exit_discretion: on|off, outputs, forbidden}`:缺省 on/off——模型只答 follow/skip + 叙事 + 风险事件,不能改任何价位与仓位,持仓期零模型调用;最终取值由 A/C 臂配对证据决定。
- `roles[6]`:固定顺序 radar / judge / geometry / risk / holding / execution,每片 `{title, summary, rules[{text, executor: code|model, ref, primitive}]}`;只有 judge 片可能含 `executor:'model'`。
- `unmapped[{code, path, severity: block|warn, message, source: compiler|import}]` 与 `deployable`(无 block)。compiler 侧 block:做空/双向(IR 候选 long-only)、杠杆 >20、scalp、Pine 原语、universe.screen、no_stop、未知原语;warn:限价入场 / 多档止盈(CandidateV0 还没接)、legacy 兼容标记。import 侧:内置策略译文丢掉的原规则语义。
- `evidence_refs {report_ids}`:evidence 会变,不嵌进绑定。

**内置策略译文**(`research/strategies/import-builtin.ts`):breakout_retest(1h,回踩确认无原语 → 突破信号 + 限价挂回踩支撑 structure_level 12 根时效)、mtf_alignment(15m 触发 / 1h 确认,原 5m 属 scalp)、vol_compression_expansion(1h,BB⊂KC squeeze 近似带宽分位)全译;range_mean_reversion 部分可译(缺回归概率门);funding_oi_extreme 规则未编码(缺资金费率 / OI / 结算时间窗原语),只建草稿无版本。全部只译做多一侧,perp 1 倍。

**前端**:侧栏去掉「策略库」;`#strategies` 保留为「实盘部署台」(不在侧栏,`?id=<实盘策略 id>` 直接打开详情)。`#my-strategies?id=<rs_id>&tab=deploy` = 详情「部署」页签:部署状态(只读,读 `/api/strategies` 与 `/api/strategies/allocator`,按 lab_strategy_id 对上;部署模式由实盘旧状态映射 shadow→影子、paper→模拟、live_capped→实盘限额,头版本未到 paper 但 activatable 时按模拟)+ 规则拆分预览(六片 + 未映射)。列表「实盘」胶囊 = 在票池或部署模式为模拟/实盘(研究侧 status 不算)。研究页新建实验抽屉删掉「B 臂原策略(策略库版本)」下拉,改为从「我的策略」载入当前版本 IR,不再发 `source_strategy_ref`。react-query key:`['research','my-strategy-binding',id,version]`、`['strategies']`、`['allocator']`。

### 9.48 记忆分域(2026-09-23)

> 设计:`docs/design/self-evolution-2026-09-23.md` §5 / §2.2(工单 P0-2);运行时契约 `docs/demo/memory.md` §1.1 / §2 / §3 / §7。后端 store 层已落地(memory.ts / types.ts / bots.ts / 迁移 0040);**本节的路由参数还没接**(http.ts 归并行 session,diff 在 memory.md §7「待接线」),接之前前端按下面的形状做兼容即可,不传新参数时行为不变。

**MemoryItem.scope**(`GET /api/memory`、`/api/memory/:id`、`/api/memory/search` 的 item 都带):

```ts
type MemoryLayer = 'global' | 'role' | 'strategy' | 'symbol' | 'thread';
scope: {
  layer: MemoryLayer;          // 旧记忆迁移回填:有 symbol → 'symbol',否则 'global'
  role: BotRole | null;        // layer='role' 时必有(这条记忆属于哪个角色)
  strategy_id: string | null;  // layer='strategy' 时必有
  symbol: string | null;       // layer='symbol' 时必有
  timeframe: string | null;
  regime: string | null;
  thread_id: string | null;    // layer='thread' 时必有
}
memory_stats: { cited_n: number; mean_r_when_cited: number | null; mean_regret_when_cited: number | null }
// 仅 list / get 带(search 的 hit.item 不带);判断引用这条记忆的 episode 结算后回写,null = 还没有可算的 R,不是 0
```

事件新增两种 kind:`outcome`(detail 是 JSON `{episode_id, outcome_r, regret_r}`,出现在 `GET /api/memory/:id` 的 events 里)与 `write_denied`(写权拒绝留痕,memory_id 恒为 `'-'`,不挂在任何条目下)。

**查询参数(全部可选,不传 = 现状)**:

- `GET /api/memory?status=&symbol=&limit=&layer=&role=&strategy_id=` —— `layer` 精确过滤层;`role` 过滤 role 层归属;`strategy_id` 过滤策略。
- `GET /api/memory/search?q=&symbol=&regime=&tags=&reader_role=&strategy_id=` —— `reader_role` 缺省 `gate_captain`(UI 搜索 = 读全部层);传别的角色 = 「以这个角色的眼睛看」,按读权矩阵过滤并按层配额(strategy 2 / symbol 2 / global 1 / role 1 / thread 1,空层让位)。`strategy_id` 给了则 strategy 层只返回同策略。
- `POST /api/memory {content, kind?, symbol?, regime?, tags?, layer?, role?, strategy_id?, thread_id?}` —— 用户手写,任何层都允许;layer 与必带字段不一致 → 400。

**写权拒绝**:角色越权写入(例如判断模块 thread_manager 写任何层、radar 写 global)→ 403 `{error:{code:'memory_write_denied', message:'记忆写权拒绝:…'}}`(接线时 catch 要把 `e.code` 传给 `fail`,否则 code 落成默认 `'error'`,status 仍是 403)。用户(proposed_by='user')不受限。

**BotProfile.memory_scope**(`GET /api/bots` 等返回的 profile):从自由文本改为结构化

```ts
memory_scope: { read: MemoryLayer[]; write: MemoryLayer[]; note: string | null }  // note = 原来那段说明文字
```

读写矩阵(与 memory.md §1.1 同源,代码常量 `MEMORY_MATRIX`):thread_manager 读 global+strategy+symbol、不写;reviewer 读全部、写 role(自己)/strategy/symbol/global;gate_captain 读写全部;radar 读 global+symbol、写 role(自己);strategy_lab 读写 strategy+global;portfolio_manager 只读 role(自己的 calibration);asp_agent 读 global;risk_sentinel / executor 无。前端 `api/types.ts` 的 `memory_scope: string` 需要跟着改(目前没有组件渲染它,不会崩)。

**前端建议(不强制)**:记忆页的范围列用 `layer` 打标(全局 / 角色:xx / 策略:xx / 币:xx / 线程),详情抽屉显示 `memory_stats`(cited_n ≥ 1 时);团队页角色卡把 `memory_scope.read/write` 画成两排层标签,`note` 做副标题。

### 9.49 人工核实利空事件(2026-09-23)

背景:`holding-policy.ts` 的 `verified_material_event` 分支(持仓放开 REDUCE/EXIT、挂单放开 INVALIDATE)以前没有生产者,runtime 从不传 `event`,分支不可达(judgment-exit-redesign §7 第 4 条)。本节给它一个**人工**生产者;信息员自由文本 `risk_events` 未核实,按设计**不**自动产生事件。

**线程字段**(`StrategyThread`,json 存储,可选,无迁移):

```ts
verified_event?: { id: string; material: true; verified_by: 'user' | 'risk_service'; adverse_side: 'long' | 'short'; observed_at: number; note: string } | null;
```

**路由**

- `POST /api/threads/:id/verified-event`,body `{ adverse_side: 'long'|'short', note: string }`(note 必填,截 500 字)。`verified_by='user'`、`observed_at=now`、`id='vevt-…'`。返回 200 `{ thread, review_queued }`。
  - 400 `bad_request`:adverse_side 非法 / note 为空;400 `side_mismatch`:adverse_side ≠ 线程方向(对本线程不是利空);404 `not_found`;409 `thread_not_open`。
  - 副作用:写一条 activity(`kind='info_update'`,level warn,标题「XXX 人工核实利空事件」,`data.verified_event`);立即 `reviewThread(id, {kind:'info_update', detail:'人工核实利空事件'})`。
- `DELETE /api/threads/:id/verified-event`:清成 null,写 activity(level info,「撤销人工核实利空事件」),再尝试排一次复查(走正常节流)。没有事件时幂等返回 `{ thread, review_queued:false }`。

**语义**

- 复查时 runtime 把 `thread.verified_event` 同时喂给模型前的允许动作集(`buildContext.verified_event`)和模型后的复核(`evaluateHoldingReview({ event })`),两处一致;`holding_review.reason='verified_material_event'`、`attention=true`。
- 有效期沿用 holding-policy:`observed_at` 在开仓之后且距复查时刻 ≤ 180s 才命中;过期的事件留在线程上但无效(UI 可显示为「已过期」,或调 DELETE 清掉)。
- 节流:事件 `observed_at > last_review_at`(还没被复查过)时 `reviewThread` 绕过 horizon 节流;复查一开始就会更新 `last_review_at`,之后恢复正常节奏。**不**借用 `thread.attention`(那是异常码,会与 ENTRY_REMAINDER / PROTECTION_MISSING 互相覆盖)。
- 放开的是「允许」,不是「强制」:REDUCE/EXIT 仍由模型选,`required_action` 为 null。

**前端建议(不强制)**:线程详情加「标记已核实利空」按钮(方向默认线程方向,note 必填)与「撤销」;有 `verified_event` 时在线程卡上显示 note 与剩余有效秒数。

### 9.50 CandidateV0 影子候选(2026-09-23)

实现 `packages/gateway/src/demo/strategy-candidate.ts` + `routes-candidates.ts`,迁移 `0041_strategy_candidates.sql`,说明 `docs/research/candidate-v0-2026-09-23.md`。研究台 StrategyIR(没有合格的 ≤1h long-only 版本时,用合成的 1h 唐奇安突破)在每根策略周期收盘时由代码算出做多候选,和同时段模型判断配对,到期后结算。**零下单、零模型,只读路由。**

`GET /api/candidates?limit=100&cursor=&symbol=&strategy_id=` 返回 `{ rows: StrategyCandidate[], next_cursor: string | null, limit }`。按 `as_of` 倒序;`cursor` 原样回传上一页的 `next_cursor`;limit 取值 1–500。

```ts
interface StrategyCandidate {
  id: string; version_tag: 'candidate-v0'; at: number; as_of: number;   // as_of = 信号根收盘(整点边界),入场在下一根 open
  symbol: string; timeframe: string; strategy_id: string; version: number; ir_hash: string;
  ir_source: 'research_strategy_version' | 'synthesized_legacy'; origin: 'online' | 'replay';
  direction: 'long'; entry_type: 'next_open_market';
  entry_ref: number; stop: number; target: number | null; target_source: 'fixed_r_target' | 'structure_target' | null;
  rr: number | null; invalidation: number;       // 失效线 = 止损(单线规则)
  horizon_bars: number; reason: string; unmapped: string[]; view_bars: number;  // unmapped = IR 要求但 V0 做不到的,原文展示
  status: 'open' | 'settled';
  model: null | {                                // null = 配对窗口(as_of + 1 根)还没关
    status: 'matched' | 'none';
    bucket: 'propose_same' | 'propose_opposite' | 'no_trade' | 'watch' | 'review' | 'no_judgment' | 'no_episode';
    episode_id: string | null; at: number | null; as_of: number | null; mode: 'scan' | 'review' | null;
    action: string | null; direction: string | null; strategy_id: string | null; trigger: string | null;
    gates_failed: string[]; intent: boolean; matched_at: number;   // 最终闸结果:没过的闸名 / 闸后是否生成 intent
  };
  settlement: null | {
    source: 'plan_walk' | 'invalid' | 'unscoreable'; settled_at: number; horizon_bars: number; bars_seen: number; note: string;
    plan: CandidateLeg | null;    // 计划腿:止损/目标不动,到期按收盘(simulateOutcome)
    trail: CandidateLeg | null;   // 吊灯腿:入场起 HH − 3×ATR22,只收紧、无目标
  };
}
interface CandidateLeg { status: string; r: number | null; net_r?: number | null; fill_price: number | null; exit_price: number | null; bars_held: number | null; mae_r?: number | null; mfe_r?: number | null }
```

`GET /api/candidates/summary?since=` 返回:

```ts
{
  version: 'candidate-v0', n, open, settled, scoreable, since, first_as_of, last_as_of,
  mean_rr, share_with_target, plan_expectancy_r, plan_net_expectancy_r, trail_expectancy_r, plan_win_rate,  // 比例为小数
  nonoverlap: { n, plan_expectancy_r, plan_net_expectancy_r, trail_expectancy_r },  // 同币上一条计划腿未出场时跳过
  by_symbol: Record<string, { n, settled, plan_mean_r, trail_mean_r }>,
  by_strategy: Record<'<strategy_id>@<version>', { n, settled, plan_mean_r, trail_mean_r, strategy_id, version, ir_hash }>,
  pairing: Record<bucket | 'pending', { n, settled, plan_mean_r, trail_mean_r }>,  // 候选 × 模型判断
  model_proposals_without_candidate: number,   // 同时段模型扫描 PROPOSE,±1 根内没有 IR 候选
  unmapped: Record<string, number>, sample_note: string,
}
```

R 值都是毛 R,以「入场 − 止损」为 1R;`net_r` 按 DEFAULT_COSTS 扣除成本。`origin='replay'` 的行只会出现在离线回放的库副本里,现网库只有 `online`。

**前端建议(不强制)**:研究页或策略卡片加一个「影子候选」tab。表格列:时间、币、入场/止损/目标/RR、模型配对(bucket 着色,`gates_failed` 悬浮显示)、计划腿与吊灯腿 R。汇总卡展示 `pairing` 和两条腿的期望。`sample_note` 原样显示;`unmapped` 非空时给这一行加黄标。

### 9.51 策略一键运行 Strategy Run(2026-09-24)

设计 `docs/design/strategy-run-2026-09-24.md`。研究台策略(ResearchStrategy 某版本的 IR)直接由运行器按周期收盘扫币、按代码几何下单 / 交 Agent 把关 / 待人确认 / 只发 ASP 信号。不经旧策略库 StrategySpec。

```ts
type StrategyRunMode = 'auto' | 'agent' | 'confirm' | 'signal_only';
type StrategyRunStatus = 'running' | 'paused' | 'stopped' | 'error';
interface StrategyRun {
  id: string;                       // 'run_xxx'
  strategy_id: string; strategy_name: string;
  version: number; latest_version: number;   // latest > version → 前端提示可升级
  ir_hash: string; timeframe: string;
  mode: StrategyRunMode; market: 'spot' | 'perp'; direction: 'long' | 'short' | 'both'; leverage: number;
  symbols: string[];                // 内部符号 BTCUSDT
  risk_pct: number;                 // 每笔风险 %(与 workflow.risk_pct 同单位)
  max_open: number;
  publish_asp: boolean;
  status: StrategyRunStatus; error: string | null;
  execution: { backend: 'paper' | 'okx' | 'binance'; profile: 'demo' | 'live' | null; label: string };  // label 例:'OKX 模拟盘'
  created_at: number; updated_at: number;
  last_scan_at: number | null; next_scan_at: number | null;
  stats: { scans: number; candidates: number; orders: number; pending_approval: number; skipped: number; rejected: number; open_threads: number; closed: number; realized_r: number | null; published: number; today_orders: number };
}
interface StrategyRunEvent {
  id: string; run_id: string; at: number;
  kind: 'scan' | 'candidate' | 'agent_follow' | 'agent_skip' | 'skip' | 'order_opened' | 'order_pending' | 'order_rejected' | 'exit' | 'published' | 'error' | 'status';
  symbol: string | null; message: string;       // message 是给人看的中文一句话
  data: Record<string, unknown> | null;         // candidate 时含 entry_ref/stop/target/rr/as_of;order_* 含 thread_id
}
interface StrategyRunPreflight {
  strategy_id: string; version: number; timeframe: string;
  deployable: boolean;
  blockers: { code: string; message: string }[];   // 有任何一条就不能运行(编译 block、现货做空、scalp 周期、无 IR…)
  warnings: { code: string; message: string }[];   // 能跑但要提示(没回测过、unmapped warn、ASP 没身份…)
  defaults: { mode: StrategyRunMode; market: 'spot' | 'perp'; leverage: number; symbols: string[]; risk_pct: number; max_open: number; publish_asp: boolean };
  watchlist: string[];                              // 用户观察列表,供「用观察列表」一键替换
  execution: StrategyRun['execution'];
  requires_live_confirm: boolean;                   // true → POST 必须带 confirm:'LIVE'
  asp: { identity: boolean; active: boolean; publisher_enabled: boolean };
  existing_run: StrategyRun | null;                 // 已有非 stopped 运行 → 前端进入编辑态
}
```

路由:

- `GET /api/strategy-runs` → `{ runs: StrategyRun[] }`(含 stopped,按 updated_at 倒序)
- `GET /api/strategy-runs/preflight?strategy_id=&version=` → `StrategyRunPreflight`(version 缺省 = 当前版本)
- `POST /api/strategy-runs` body `{ strategy_id, version?, mode, market, symbols, risk_pct, max_open, publish_asp, confirm? }` → `{ run: StrategyRun, scan: StrategyRunEvent[] }`。同策略已有非 stopped 运行时等同 PATCH 它。创建后立刻对最近一根已收盘 K 线扫一遍,`scan` 是这次产生的事件。409 = blocker / 需要 LIVE 确认(body `{ error, code }`)。
- `PATCH /api/strategy-runs/:id` body 任意子集 `{ status: 'running'|'paused'|'stopped', mode, symbols, risk_pct, max_open, publish_asp, version, confirm? }` → `{ run }`
- `POST /api/strategy-runs/:id/scan` → `{ run, scan: StrategyRunEvent[] }`(同 as_of 去重,不会重复下单)
- `GET /api/strategy-runs/:id/events?limit=50&cursor=` → `{ rows: StrategyRunEvent[], next_cursor }`

SSE:`strategy_run.updated`(payload = StrategyRun)、`strategy_run.event`(payload = StrategyRunEvent)。

ASP payload 增量(§9.39 发布器):`strategy?: { id, name, version, timeframe, run_id }`、`market`、`traded`;新事件 kind `strategy_signal`。


§9.51 后端能力补充（2026-09-24 第二轮，现有字段名不变）：
- `direction` 扩展为 `long | short | both`；空头只在 `market=perp` 放行。`candidate.data.direction` 表示本次候选实际方向。
- `candidate.data.entry_type` 为 `next_open_market | limit`；限价时效按信号根收盘 + `expiry_bars × 周期`，确认撤完未成交余量后记 `skip`，`data.code=entry_expired`。未确认撤单不伪报成功。
- `candidate.data.take_profits` 为研究核解析的 `{price:十进制字符串,size_pct:number}[]`；多档预检 `warnings.code=targets_partial`。纸面/OKX 只挂最近首档，按归一比例指定数量（向下对齐交易步长）；线程 `tp_partial_unsupported` 保留其余档位与中文说明，余仓由止损/信号/时间退出管理。`run_take_profit` 保存首档数量与 CID/回执状态，`run_targets` 保存完整研究目标供审计和重闸。Binance 多档仍 blocker，提示换通道或改为单档。
- `universe.screen` 每根按运行币池等权市场因子先筛后生成候选；筛选不足历史记 skip，池内某币缺最新根时整池重试，预检 `screen_pool` 说明因子口径。
- ASP `entry_type` 同样支持 `limit`，`take_profit_sizes?:number[]` 与 `take_profit` 对齐；候选发布完整研究目标，reason 写明本账户的多档执行降级；线程入场事件仅报告实际首档及其比例。
- `new_signal_policy`、`trailing_not_connected` warnings 继续说明未执行的同币新信号管理和移动止损规则。

§9.51 运行/研究口径补充（2026-09-25 R14/R19；覆盖上段移损/新信号未接通的统一 warning）：

- `StrategyRun.symbols_source?: {kind:'fixed'} | {kind:'radar',tier:'short'|'swing'|'weekly',top_n:number}`。缺省/旧 JSON 按 `fixed`；创建与 PATCH 接受此字段，严格拒绝未知字段/档位和非 1–30 整数的 `top_n`。雷达模式每轮入场扫描前调用 `radarSymbols(tier,top_n)`，按去重后的最新榜单取前 N，并合并本运行尚未结束的持仓/挂单；保留项不占榜单 N，因此实际 `symbols` 可超过 30。空榜合法；读取失败本轮不生成入场，持仓管理先行且保留重试。切回 fixed 可同时显式传 `symbols`。
- `StrategyRunPreflight.defaults.symbols_source` 返回所选来源；新增 `sizing_mode:'fixed_risk'|'vol_target'`。预检服务第四参数可传来源；HTTP GET 的来源参数需要路由 owner 透传后才支持，创建/PATCH 已通过同一校验。缺雷达依赖为 `radar_not_connected` blocker。实盘修改来源与修改固定币池一样需要已有的 `LIVE` 确认。
- `scan.data` 增加 `symbols_source,symbols,added,removed,retained`，雷达时另有 `ranked`；都描述本根实际币池。`candidate.data` 增加 `sizing_mode`，波动率目标候选另有 `size_weight,size_note`。
- 波动率目标候选复用 `volTargetWeight`，独立拉足波动率回看历史，不扩大原语信号视图。`sizeRunOrder` 复用订单核首腿/现金算式：首腿保证金 = 权益 × weight / (1+max_adds)，非 add 策略 `max_adds=0`；数量 = 可负担保证金 × 封顶杠杆 / 实际入场参考价，现金预留手续费、数量按步长向下对齐。现货杠杆为 1；加仓沿用冻结的首腿额度。无 `size_weight` 返回原 fixed_risk 路径。`openSized` 接入后仍须走原组合经理/风控、冻结审批计划及发送前只拒不改的重闸；缺接线报 `vol_target_not_connected`，禁止静默回退固定风险。
- 持仓管理复用 `orderManager`（有 order）/ `irExit`（旧 IR），吊灯、ATR、保本和结构止损只收紧；确认首档 TP 成交后可按 `breakeven_after_tp` 移至均价。初始止损、手续费口径、高低水位和已处理根持久化，入场所在根按第 1 根，断轮/重启逐根补算，缺行情不推进。`stop_moved` 事件带 `{thread_id,as_of,new_stop,reason}`，`new_stop` 为十进制字符串。`moveStop` 未确认先对账同一目标/CID，不换目标盲发；失败不能阻止机械离场。移损/成交状态依赖未接时保留 `trailing_not_connected`。
- 新信号复用订单核分支：未成交同向 replace/keep；反向未成交先撤；已成交同向 add/ignore；反向仅永续 flip。替换/反手确认旧腿终态后才能新开；等待对账的候选持久化，可在有效期内重启续接。新腿进入提交相位后未知不重发；缺可核对的新线程时须人工处理。add 通过原仓位等额腿依赖执行，名额含在途/待批/未知腿，旧保护与原持仓期限不被新候选替换。confirm 的反手必须审批完整复合动作，不能先自动平仓。roll 无费结转仍未实现；缺 add/confirm-flip 接线继续 `new_signal_policy` warning。旧版本持仓不接新版本信号。
- 本轮不开放 3m/5m；多档 TP 仍只执行首档，后续档位保留既有 `targets_partial` 提示。实际行情/成交、交易所步长、费用或风控限额不同可造成研究与执行差异；对拍证明相同输入下规则与目标数量的口径。
- 续接与雷达的边界：新候选必须先读本轮雷达；此前已通过过滤且持久化的候选，在原有效期内独立续接，不重新查榜或重问模型。雷达失败阻止的是本轮新候选生成。新腿 unknown 保存 `new_thread_id`（若回执已提供），通过 `reconcileOpen(run,candidate_id,thread_id)` 只读查询原 CID/意图账本；只有确定的 `opened/rejected` 才解除等待，查不到/unknown 不解除，不按过期清掉未知提交。缺对账接线时明确等待人工。存在待续接/未知动作时禁止切换执行通道。

#### 移损（2026-09-25）

- `StrategyRunDeps.moveStop(thread,new_stop,reason)` 已连接独立安全执行链（`execution-stop.ts`）；不复用带 60 秒节流或失败补偿平仓的 `placeProtection`。只支持 paper / OKX，按多头上移、空头下移严格收紧；十进制字符串精确比较，不按 tick 舍入改价。重闸只能拒绝，不改目标、数量或归属。暂停/停止运行仍按运行器既有规则管理存量仓位；工作流暂停、Executor 暂停、halt 或执行环境变化拒绝提交。
- 迁移 `0049_stop_moves.sql`：`demo_stop_moves` 以 `(thread_id,target_stop)` 唯一，等价十进制目标先规范化；字段为 `{thread_id,run_id?,target_stop,old_stop,new_cid,old_cid,old_algo_id,new_algo_id,phase,method,execution_key,request_json,reason,detail,attention,at,updated_at}`。金额/数量为十进制字符串，时间为 unix 毫秒整数；`request_json` 冻结币对、市场、方向、数量和旧保护事实。`new_cid` 与 `submitted` 在任何写调用前落库，非 amend 的新 CID 同事务登记为待核归属（线程 stop 仍是旧值），重启巡检不能误判已挂新保护为缺失。
- phase：`planned → submitted → confirmed → replaced`；发送前明确拒绝或通道明确拒单可到 `failed`；提交后未确认到 `unknown`，只允许查询原 CID / algo ID 后到 `confirmed`。`unknown` 非终态，不按超时/查不到释放，不重发，也不提交新目标。每次迁移同步写 `demo_stop_move_events`；线程新 stop 与 `confirmed` 在同一事务提交。同目标重入返回当前结果，`submitted/unknown` 重入只做对账。
- paper：本地原子替换保护单、保留止盈，一次快照持久化；保存异常回滚内存并保持 unknown。OKX：本机 CLI 1.4.7 的 `spot/swap algo amend --newSlTriggerPx` 对应 `/api/v5/trade/amend-algos`，优先对精确旧 algo ID 改触发价，保留数量、OCO 止盈、触发价类型和原市价止损语义。CLI 不透传 amend `reqId`，此处 `new_cid` 是本地持久化操作 ID，实际确认依据为旧 algo ID 和目标价；不伪称交易所生成新 CID。
- amend ACK 本身不足以确认：查询必须证明同币对/市场/方向、活动状态、市价止损、目标价精确相等、数量覆盖线程，以及 OCO 止盈未变化。查询缺失或矛盾均返回 `ok:false`。当前 OKX 不在 amend 拒绝/超时后自动降级；不支持 amend 的通道只有显式声明 `replace` 才允许先挂新保护、确认、再撤旧，OCO 因撤单会连带止盈而拒绝走该降级。任何同向冲突（包括 `-4130`）都是新目标失败，不冒充新保护成功。
- 失败语义：新保护明确失败 → `failed,ok:false`，保留旧止损，不补偿平仓；新保护未知 → `unknown,ok:false`，旧 stop 不变，等待同一目标对账；新保护已确认而撤旧失败/未知 → `confirmed,ok:true,attention=STOP_MOVE_OLD_CANCEL_FAILED`，事件注明两张保护可能并存。撤旧调用前先记 `STOP_MOVE_OLD_CANCEL_PENDING`；只有按原 CID 核实旧单已撤才到 `replaced`。未解决 attention 阻止继续生成新目标，巡检不静默清除此 attention；现阶段须人工核对处理。线程期间被巡检关闭/减仓，撤旧结果不能用旧对象覆盖线程状态。
- StrategyRun 事件 `data.code='stop_move_phase'` 带 `{thread_id,run_id,target_stop,old_stop,new_cid,old_cid,old_algo_id,new_algo_id,phase,method,reason,attention,at}`；计划/提交用 `status`，明确失败、未知或 attention 用 `error`，确认/完成用 `stop_moved`。运行器原有 `stop_moved {thread_id,as_of,new_stop,reason}` 和 `stop_move_unconfirmed` 语义不变。移损不成功不阻止机械离场。`positionState`/首档 TP 成交后的保本依赖本轮未扩展，缺失时继续既有 warning。
- 现货额外约束：止损数量须与冻结线程数量精确相等，超量也拒绝（现货无 reduceOnly 钳位）；移损不能顺带修改数量。挂新撤旧在撤旧后再次核新保护；无法证明时 `confirmed → unknown,ok:false,attention=STOP_MOVE_NEW_UNCONFIRMED`，后续只读恢复原 CID，不重复发送撤单。自动补挂入口及现货部分止盈的撤旧重挂均受未决移损账本阻断，避免巡检绕过对账进入旧补偿路径；无移损未决记录时 `placeProtection` 的既有行为保持不变。
- 补保护互斥：已进入的旧保护异步链用线程级活跃计数挡住移损（零写拒绝，可稍后重试）；移损先进入则由账本挡住后来的补挂。发送前查不到/无法唯一确认旧保护，计划明确落 `failed`，不留下 `planned` 永久阻断原保护修复；该目标仍按失败结果幂等，不自动重试失败写。

### 9.52 模型连接与角色底层 Model Connections(2026-09-25)

设计 `docs/design/chat-to-strategy-loop-2026-09-25.md` §3.7 / 验收 F1–F2。现状:只有 `workflow.brain / cheap_brain` 两个 CLI 槽位(pi/claude/codex/stub),`bots.model_pin` 落库但网关不读。本节把「底层」变成**连接 + 角色绑定**,两个旧槽位保留为未绑定角色的回退,不迁移、不破坏。

```ts
type ConnectionKind = 'openrouter' | 'anthropic' | 'deepseek' | 'zai' | 'openai' | 'openai_compatible' | 'cli';
type CliTool = 'pi' | 'claude' | 'codex';
interface ModelConnection {
  id: string;                         // 'mc_xxx'
  kind: ConnectionKind;
  label: string;                      // 用户起的名字,缺省按 kind
  base_url: string | null;            // openai_compatible 必填;其余用内置缺省
  cli: CliTool | null;                // kind='cli' 时必填
  key_masked: string | null;          // 'sk-or-…c6a5e9';明文永不回传
  status: 'untested' | 'ok' | 'error';
  last_test: { at: number; ok: boolean; latency_ms: number | null; detail: string } | null;
  models_hint: string[];              // 连接可用模型的常用列表(openrouter 取 /models 过滤,cli 取 brainCatalog)
  created_at: number; updated_at: number;
}
type ModelRole = 'chat' | 'judge' | 'research' | 'filter' | 'reviewer' | 'utility' | 'decision';
// chat=Agent 对话(chat.ts);judge=判断/复查(executeEpisode 主脑);research=研究 loop 规划/诊断/撰写;
// filter=策略运行 agent 模式入场过滤;reviewer=复盘/反思/教训;utility=信息员/筛选/仓位意见/议会等其余副脑调用;
// decision=判断要素(结构化决策,Jev 等 Decisions API)。
interface RoleBinding { role: ModelRole; connection_id: string | null; model: string | null; } // null = 回退旧槽位
interface ModelsView {
  connections: ModelConnection[];
  bindings: RoleBinding[];            // 7 个角色都返回
  effective: Record<ModelRole, { source: 'binding' | 'fallback_main' | 'fallback_cheap' | 'unset'; name: string }>; // decision 未绑定 = 'unset'
  cli_detected: { tool: CliTool; command: string | null; ok: boolean }[];
}
```

路由(前缀 `/api/models`):
- `GET /api/models` → `ModelsView`。
- `POST /api/models/connections` `{kind, label?, base_url?, cli?, api_key?}` → `ModelConnection`(api_key 只进服务端)。`PATCH /api/models/connections/:id` 同字段(`api_key` 缺省 = 不改);`DELETE` 同 id(有角色绑定时 409 `connection_in_use`,body 列出角色)。
- `POST /api/models/connections/:id/test` `{model?}` → `last_test`。LLM 连接发一次「只回复 ok」;decision 连接发一个 1 问 noul 请求;cli 走现有 `testBrain`。
- `POST /api/models/bindings/:role/test` → `RoleTestResult = last_test & {role, source: EffectiveSource, name}`(2026-09-25 补):用该角色**当前生效**的底层测一次。绑定 → 等同 `connections/:id/test` 带绑定的模型(结果写回连接);回退 → 直接调主脑 / 副脑一次(不改连接);decision 未绑定 → `ok:false`。未知角色 404。
- `PUT /api/models/bindings/:role` `{connection_id|null, model|null}` → `ModelsView`。`decision` 只能绑 openrouter(Decisions API)或 null;其余角色不能绑 decision-only 模型(model id 以 `typesafe/` 或 `~typesafe/` 开头即 decision-only)。
- SSE `models.changed`(data=ModelsView)。

存储:连接元数据进状态库新表 `model_connections` / `model_role_bindings`(迁移 0045);**密钥单独存** `<状态库目录>/secrets/model-keys.json`(目录 700、文件 600,`{[connection_id]: api_key}`),不进库、不进日志(走 `log()` 脱敏)、不进任何 API 响应。启动时若存在 `~/.trade-gate-okx/openrouter.env` 且还没有 openrouter 连接,自动导入为一条 `openrouter` 连接(label「OpenRouter(导入)」),并把 `decision` 绑到 `~typesafe/jev-latest`。

执行语义:
- `runtime.brainForRole(role)`:有绑定 → HTTP brain 或 CLI brain;无绑定 → `chat/judge/research` 回退 `mainBrain()`,`filter/reviewer/utility` 回退 `cheapBrain()`。现有 `mainBrain()/cheapBrain()` 调用点逐个换成对应 role(对照表见上)。
- HTTP brain(`brain-http.ts`)实现现有 `Brain` 接口:OpenAI 兼容 `POST {base}/chat/completions`(openrouter/deepseek/zai/openai/openai_compatible),Anthropic `POST /v1/messages`;超时、429/5xx 重试 ≤2 次;`BrainResult` 的 token 用量与 `usage.cost`(openrouter 直接给美元)照常写 `llm_usage`。出站走本机代理(沿用网关现有 OKX 出站的代理做法)。
- 绑定失效(401/403/连不上)→ 该角色调用抛 `model_connection_failed:<role>:<detail>`,**不静默回退**旧槽位;楼层与顶栏显示该角色红点。
- `DecisionClient`(`decisions.ts`,给 §9.53 判断要素用):
  ```ts
  type DecisionQuestion =
    | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
    | { type: 'choice'; instructions: string; criteria: Record<string, string> }
    | { type: 'score'; instructions: string; criteria: string[] };
  type DecisionAnswer =
    | { type: 'noul'; noul: number }
    | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
    | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };
  interface DecisionResult { model: string; answers: Record<string, DecisionAnswer>; usage: { input_tokens: number; cost_usd: number | null }; latency_ms: number; }
  interface DecisionClient {
    name: string;                                   // 'openrouter:~typesafe/jev-latest'
    decide(req: { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> }, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DecisionResult>;
  }
  ```
  `POST https://openrouter.ai/api/alpha/decisions {model, state, questions}`;并发闸(缺省 8)、429 退避、日花费闸 `workflow.decision_daily_usd_cap`(缺省 2 美元,超了抛 `decision_budget_exhausted`)。`runtime.decisionClient()` 返回绑定的 client,未绑定返回 null。

前端:
- **2026-09-25 重做**:`#models` 主体改为 7 张 agent 卡(对话 / 判断 / 研究 / 策略过滤 / 复盘 / 信息员·筛选 / 判断要素),每张卡分段选「本机 CLI | API key | 用默认」(decision 只有 API key(OpenRouter)| 不启用);CLI 保存时复用或自动建 `kind='cli'` 连接;API key 可选已有连接或卡内新建(POST connections);保存即 PUT 绑定;卡上「测试连接」走 `bindings/:role/test`。回退主脑 / 副脑收成顶部一行说明 + 折叠的「高级」,连接列表收进折叠的「已保存的连接」。下面一条是初版描述。
- 新页 `#models`「模型连接」:连接列表(类型图标、名字、掩码 key、状态点、上次测试、测试/编辑/删除),「添加连接」弹层(选类型 → 填 key 或选本机 CLI → 保存并测试);下方「角色底层」表,7 行,每行选连接 + 模型(模型下拉取 `models_hint`,可手输),显示当前生效来源(绑定 / 回退主脑 / 回退副脑)。
- **首页(楼层)**:顶栏加「模型连接 · n 个可用」胶囊,点开到 `#models`;没有任何可用连接且旧槽位也测不通时,楼层顶部一条引导横幅。楼层角色卡的「用什么模型」改读 `effective`(替换 `lib/role-brain.ts` 的两槽推断)。
- 设置页原「大脑」控件保留为「回退主脑 / 副脑」,文案说明「未单独绑定的角色用这里」。

### 9.53 推荐资产 → 矩阵研究 Study → 判断要素(IR judge 块)(2026-09-25)

设计 `docs/design/chat-to-strategy-loop-2026-09-25.md` §2–§3 / 验收 A、B、C、D1、G。复用引擎:`research/batch/{families,evaluate,study}.ts`(变体、分段、门槛、Deflated Sharpe)、`research/improve/*`(诊断 → 生成器 → 验证)、`judgment-replay/events.ts`(特征)。不新造回测核。

#### 周期档与流动性门

```ts
type Horizon = 'short' | 'mid' | 'long';
const HORIZON_TIMEFRAMES: Record<Horizon, string[]> = { short: ['3m', '5m', '15m'], mid: ['1h', '4h'], long: ['12h', '1d'] };
```
短线档只对高流动性永续开放:OKX 24h 成交额 ≥ `SHORT_MIN_QUOTE_VOL_USD`(缺省 3 亿)且近价 ±0.5% 双边挂单深度 ≥ `SHORT_MIN_DEPTH_USD`(缺省 200 万,取不到深度时只看成交额)。不达标 → 该资产短线档 `eligible:false, reason:'liquidity'`,不进矩阵。

#### A. 推荐资产(对话工具 `recommend_assets`,代码计算,零模型)

输入 `{symbols?: string[]; top_n?: number; horizons?: Horizon[]; market?: 'spot'|'perp'}`(symbols 空 → 取每日全市场扫描前 top_n,缺省 8)。输出:
```ts
interface AssetRecommendation {
  as_of: number;
  source: { universe_scan_at: number | null; regime_at: number | null };
  rows: {
    symbol: string; market: 'spot' | 'perp'; quote_vol_24h: number | null; depth_usd_05: number | null;
    regime: 'bull' | 'bear' | 'range' | 'volatile' | null;     // runtime.dailyRegimeFor
    scan: { rank: number | null; score: number | null; horizon_fit: Partial<Record<'short'|'swing'|'weekly', number>> } | null;
    horizons: Record<Horizon, { eligible: boolean; reason: string | null; direction: 'long' | 'short' | 'both' | null; families: FamilyKey[]; evidence: string[] }>;
  }[];
  warnings: string[];
}
```
族建议规则(代码):bull → 多头 breakout/ma_trend/ema_cross/pullback;bear → 永续空头同族(现货档标不适合);range → mean_reversion/smc 双向;volatile → breakout + 仅长线。evidence 每条是可点回来源的短句(扫描名次/regime/成交额)。
对话里模型拿到工具结果后在消息里放一个 `{kind:'recommendation_ref', recommendation_id}` block(推荐结果落库 `asset_recommendations`,GET `/api/recommendations/:id`),前端渲染推荐卡;卡上「去研究台验证」= `POST /api/research/studies` 带 `{recommendation_id}`,按卡上 eligible 格子预填。

#### B. 矩阵研究 matrix study(2026-09-25 修订,实现:`research/matrix-study/*`、`routes-matrix-study.ts`、迁移 0048)

与旧 `ResearchStudy / research_studies`(预注册单次研究)不是同一对象;路由前缀、表名、SSE 名都带 `matrix`。首版收缩(评审第四节):资产池 × `15m/4h/1d` × 运行器能完整执行的单资产族(breakout / ma_trend / ema_cross / pullback / mean_reversion / smc)× 两臂 `code | code_judge`;`3m/5m` 标 `research_only`,组合族 xsmom/carry 标 `not_applicable`,都不评估、不填零;不启用 model 生成器。

```ts
type MatrixTimeframe = '3m' | '5m' | '15m' | '4h' | '1d';          // horizon:15m/3m/5m→short、4h→mid、1d→long(1h/12h 不在首版)
type MatrixArm = 'code' | 'code_judge';
type MatrixStudyStatus = 'queued' | 'running' | 'ready_to_finalize' | 'finalizing' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
type MatrixStage = 'queued' | 'data' | 'matrix' | 'iterate' | 'sealed' | 'holdout' | 'done';
type FailureCause = 'cost_dominated' | 'insufficient_evidence' | 'unsupported_execution' | 'underperform_hold';
interface MatrixStudySpec {                     // POST 体 {spec?, recommendation_id?, idempotency_key?};未知字段 400
  research_program_id: string;                  // 缺省 prog_hash(资产池 + 市场):改名 / 新建 Study 不重置试验历史
  symbols: string[];                            // ≤ 6
  timeframes: MatrixTimeframe[];                // 缺省 ['15m','4h','1d']
  families: FamilyKey[]; market: 'spot' | 'perp'; sides: ('long' | 'short')[]; arms: MatrixArm[];
  judge: StrategyJudge | null;                  // 缺省:有 model_profile 时用 defaultJudge(take noul + quality score)
  model_profile: FrozenModelProfile | null;     // 冻结的模型配置(无凭证);缺省取 runtime 钩子;没有 → code_judge 格 not_applicable
  window_days: Partial<Record<MatrixTimeframe, number>>; // 缺省 15m 180 / 4h 730 / 1d 1460
  to_ms: number;                                // 缺省创建日 UTC 0 点 − 1ms
  split: { train: number; selection: number; holdout: number }; // 缺省 0.6/0.2/0.2,holdout 在最后
  purge_bars: number;                           // 段间最小空档(缺省 24);实际按格加大,见执行语义
  iterate: { top_k: number; generations: number; candidates_per_generation: number; patience: number }; // 缺省 3/3/4/2
  budget: { max_variants: number; max_judge_calls: number; max_judge_usd: string; wall_clock_ms: number }; // 缺省 300/20000/'1'/1_800_000
  protocol: { version: 'matrix_v1'; alpha: number; min_trades: number; block_days: number; min_blocks: number; bootstrap_replicates: number;
              max_drawdown: number; min_effect: number; min_dsr: number; seed: number; evidence_mode: 'historical_replay' | 'unseen_holdout'; boundary: 'mtm_truncate_v1' };
              // 缺省 0.025 / 30 / 5 / 20 / 999 / 0.35 / 0 / 0.95 / 20260925 / historical_replay;min_trades<30、max_drawdown>0.35 拒收
  recommendation_id: string | null;
  auto_finalize: boolean;                       // 缺省 true:封存后自动一次释放留出;false 等 POST finalize
  portfolio: { risk_pct: number; max_open: number };   // 留出段账户级回放,缺省 0.5(%)/ 3
  origin: { chat_session_id: string | null };   // 透传给完成回调
}
interface MatrixCellView {                      // GET /:id 的 cells[]
  id: string;                                   // `${symbol}|${tf}|${family}|${side}|${arm}`
  symbol: string; timeframe: MatrixTimeframe; horizon: 'short' | 'mid' | 'long'; family: FamilyKey; side: 'long' | 'short'; arm: MatrixArm;
  applicability: 'applicable' | 'not_applicable' | 'research_only';
  reason: string | null;                        // not_applicable 原因(recommendation:liquidity / spot_cannot_short / judge_runtime_unavailable / holding_exceeds_window…),或 bounded_holding_v1:max_holding_bars=N
  variants: number;
  result: { verdict: 'pass' | 'near' | 'fail' | 'ineligible'; cause: FailureCause | null; best_trial_id: string | null;
            selection: SlimScore | null; train: SlimScore | null; gates: {name; ok; value}[]; dsr: number | null; evaluated: number;
            judge_delta: { mean_daily: number | null; ci95: [number, number] | null; kept_ratio: number | null } | null } | null;
}
interface MatrixGeneration { n; cell_id; parent_trial_id; diagnosis: string; change: string; trial_id: string | null; generator: string | null; selection: SlimScore | null; promoted: boolean; note: string }
interface MatrixFinalist {
  id: string; trial_id; cell_id; arm; symbol; timeframe; family; side; ir: StrategyIR; ir_hash: string;
  selection: SlimScore; dsr: number | null;
  holdout: SlimScore | null; holdout_gross: number | null;
  test: { days; blocks; mean_daily: number | null; p_value: number | null; holm_threshold: number | null; rejected: boolean } | null;
  passed: boolean | null; cause: FailureCause | null;
  horizon: 'short' | 'mid' | 'long';
  source: { recommendation_id: string | null; radar_tier: 'short' | 'swing' | 'weekly' | null; universe_scan_at: number | null };
  portfolio: { initial; risk_pct; max_open; gross_cap; total_return; max_drawdown; trades; skipped_by_judge; skipped_by_capacity; skipped_no_stop; exposure; equity: {at; equity}[] } | null;
  judge: { candidates; follow; skip; error; uncertain } | null;
}
interface MatrixStudyView {
  id; status: MatrixStudyStatus; stage: MatrixStage; research_program_id; manifest_hash; protocol_hash; created_at; updated_at;
  progress: { done; total; eta_ms: number | null; note: string };
  holdout_state: 'sealed' | 'claimed' | 'released';
  conclusion: { kind: 'passed' | 'no_candidate'; finalist_ids: string[]; causes: Record<FailureCause, number>; not_applicable: number; research_only: number; text: string } | null;
  usage: { judge_calls: number; judge_usd: string; judge_reserved_usd: string; judge_unknown_cost_calls: number; llm_calls: number; llm_usd: string; wall_ms: number };
  ledger: { attempt_count: number; trial_count: number; study_trial_count: number;
            effective_trials: { conservative: number; by_cell: number; by_correlation: number | null; avg_correlation: number | null };
            dsr_sensitivity: { trials: number; dsr: number | null }[] } | null;
  stop_reason: string | null; error: string | null; origin; spec: MatrixStudySpec;
  // 仅详情:
  segments: Record<tf, { train; selection; holdout; purge_bars }>; cells: MatrixCellView[]; generations: MatrixGeneration[];
  finalists: MatrixFinalist[]; notes: string[]; release: { status; released_at } | null; adoptions: { finalist_id; adopted: { strategy_id; version } }[];
}
```

路由(前缀 `/api/research/matrix-studies`,须注册在 eventRoutes 之前):
- `POST /estimate` `{spec?, recommendation_id?}` → `{spec, estimate:{cells:{total,applicable,not_applicable,research_only}, matrix_trials, iteration_trials_max, variants, judge_calls, judge_usd, data:{series,bars,cold_fetch_ms_upper}, within_budget, warnings}, cells:[{id,applicability,reason,variants}]}`(不落库)。
- `GET /prefill?recommendation_id=` → `{spec, notes, estimate}`(只取推荐卡 eligible 格子;方向、流动性门按资产逐格冻结)。
- `POST /` `{spec?, recommendation_id?, idempotency_key?}` → 201 `MatrixStudyView`;超 `max_variants` 400 `budget_max_variants_exceeded`;同谱系留出区间已被占 409 `holdout_range_already_used`;同 idempotency_key 返回原 Study。
- `GET /?limit=` → `{items}`(无格子明细);`GET /:id`;`GET /:id/events?after_seq=` → `{items: MatrixEvent[]}`。
- `POST /:id/cancel`、`POST /:id/resume`(cancelled / interrupted / failed → queued;留出已 claimed 的回 finalizing)。
- `POST /:id/finalize` `{expected_manifest_hash}` → 202(auto_finalize=false 时用;只在 ready_to_finalize)。
- `POST /:id/adopt` `{finalist_id, name?}` → `{strategy_id, version, preflight:{deployable, warnings}, horizon, source}`;只允许留出段通过的 finalist;运行器预检有 blocker → 409 `adopt_preflight_blocked:<code>(<原因>)` 且不落库;同一 finalist 幂等。
- SSE `research.matrix_study`,data = `MatrixEvent {seq, study_id, at, stage, status, kind:'status'|'progress'|'cell'|'generation'|'finalist'|'conclusion'|'adopted', progress, cell?, generation?, finalist?, conclusion?, adopted?}`;事件先写 outbox,至少一次投递,按 seq 幂等。

执行语义(必须):
- **manifest 冻结**:创建时展开格子 / 变体 IR / 每格三段 / 各哈希,写 `research_matrix_studies.manifest_json` 与 `research_study_cells`,触发器禁止修改。
- **三段与隔离**:每周期外层边界 train [s,b1] / selection / holdout(最后);每格空档 = max(purge_bars, ⌈变体最大持仓 + 挂单等待 + 下根执行 × 1.25⌉),空档吃掉一段 60% 以上该格 `not_applicable: holding_exceeds_window`。无界持仓族(追踪 / 信号离场)在研究里补 `order.max_holding_bars`(15m 192 / 4h 120 / 1d 60,`bounded_holding_v1`,adopt 出去同样带着)。搜索只拿开发视图:取数截止选择段末、内存物理截断、holdout 为封存哨兵(judge/purge 的逐变体空档守卫据此强制执行);留出视图只在 release claimed + Study finalizing 时可打开,从空仓起跑。
- **试验账本**:`trial_count` = 研究谱系内看过选择段成绩的不同配置(跨 Study 按 config_hash 去重,每代每个新变体都算);`attempt_count` = 全部评估尝试(含失败 / 取消 / 恢复);`effective_trials` 只报敏感性(按格、按选择段日收益平均相关),门槛只用保守值。DSR 用谱系 trial_count + 本 Study 选择段日夏普方差。
- **门槛**(选择段,全过 = pass):笔数 ≥ min_trades、时间块 ≥ min_blocks、期望 > 0、净收益 > 0、2 倍费率 > 0、跑赢同敞口持有、回撤 ≤ max_drawdown、DSR ≥ min_dsr;`near` = 净收益与期望为正但有门没过。主因:样本 / 时间块不足 → insufficient_evidence;毛为正扣费后负 → cost_dominated;执行失败 / 无判断客户端 → unsupported_execution;其余 → underperform_hold。
- **迭代**:near 格里最好的 top_k 格进 improve 生成器(diagnosis / neighborhood / swap),每代「诊断 → 改动 → 选择段结果」写 generations,子代优于父才晋升,patience / 代数 / max_variants / 墙钟耗尽即停(stop_reason)。
- **留出**:pass 试验按选择段夏普取 top_k 封存(finalists_hash、trial_ledger_hash),finalize 在 BEGIN IMMEDIATE 内 sealed → claimed(`research_holdout_releases` UNIQUE(study_id) + 同谱系同数据范围区间重叠检查 + `research_data_exposures` 登记),一次评估全部 finalist:单格留出成绩 + 时间块 bootstrap 单侧 p + Holm(α)→ passed 需 Holm 拒绝、笔数足、净收益与 2 倍费率为正、跑赢同敞口持有 + min_effect、回撤不超限;再以同一 IR 在研究资产池全部资产上做账户级回放(`portfolio`,judge 决策复用不重复计费)。释放后本 Study 不能再登记试验(触发器),结果写一次。
- **结论**:`passed`(至少一个 finalist 通过)或 `no_candidate`,`causes` 为主因分布,`text` 写清分布;`historical_replay` 口径在文本里注明只能算回放证据。
- **取消 / 恢复**:不清零试验、尝试、判断费用与留出占用;已完成的评估复用;进程重启时 running / finalizing → interrupted(不自动重跑,未定判断调用转 unknown 保留预留)。
- **handoff**(同事务,subject matrix_study,payload 带 study_id):创建 gate_captain→strategy_lab、每代 strategy_lab→strategy_lab、封存(review)与完成(result)strategy_lab→gate_captain、失败 blocked、adopt gate_captain→thread_manager。
- **adopt**:存成 ResearchStrategy(IR 原样,含 judge 块与持仓上限),description 前缀 `[矩阵研究 <id> · horizon=<h>(…) · 来源:推荐 / 雷达档位 / 扫描时间]`(contracts 无标签字段,暂用描述);先过运行器预检(runtime.strategyRuns().preflight,缺省静态 IR 预检)。
- runtime 钩子(可选):`rt.matrixStudyHooks = { judgeProvider(), modelProfile(), onConclusion(row, conclusion), onAdopted(row, adopted) }`;服务实例 `matrixStudyService()`。

**2026-09-25 matrix study 修订**(与原稿差异):对象改名 matrix study,前缀 `/api/research/matrix-studies`,SSE `research.matrix_study`;状态机改为 queued/running/ready_to_finalize/finalizing/completed(+cancelled/failed/interrupted),阶段另列 stage;`no_winner` 并入 `completed` + `conclusion.kind='no_candidate'`;周期首版只 15m/4h/1d 可评估(3m/5m research_only,1h/12h 不在首版);`trials_counted` 拆成 ledger(attempt_count / trial_count / effective_trials / dsr_sensitivity);原 `validation` 更名 `selection`(不再当独立样本外证据);结论主因改为 cost_dominated / insufficient_evidence / unsupported_execution / underperform_hold;新增 estimate 返回格子可研究性、finalize(一次释放 + Holm)、resume、events 续传、adopt 预检与 horizon/source 标签、账户级回放 portfolio、spec.origin / auto_finalize / portfolio / protocol;金额 `max_judge_usd`、`judge_usd` 改十进制字符串。

**2026-09-25 自选策略行(「我的策略」作矩阵的行)**:spec 新增 `strategies: {strategy_id, version}[]`(请求可省 `version` = 当前版本;规格里总是具体版本;最多 6 条;策略不存在 / 已归档 / 版本不存在 → 400 `strategy_not_found:<id>[@v<n>]`),与 `families` 并存,两者合计至少一项(否则 `families_or_strategies_required`);只给 `strategies` 时 `families` 缺省为空,不再自动铺满内置族。manifest 冻结时解析快照 `my_strategies: {strategy_id, version, name, symbol, timeframe, ir, ir_hash}[]`(之后策略再改不影响本研究);详情 / 列表视图带 `my_strategies`(不含 IR)给前端显示名字。展开规则:资产 × 周期 × 该策略 × 方向 × 臂,格子 `family = "my:<strategy_id>@v<version>"`,variants = 该版 IR 一个(param `v<n>`)。周期:IR 不带周期、参数按根数解释,按格子周期跑,策略登记周期不同时 reason 追加 `timeframe_override:<原>→<格>`;IR 在格子周期上过不了结构检查 → not_applicable `my_strategy_incompatible:<检查名>`。方向:`order.direction`(无 order 块 = long)只进同向格;`both` 只在 long 格评估一次,short 格 `my_strategy_direction:both_evaluated_in_long_cell`;不符 → `my_strategy_direction:<dir>`。市场:IR `order.market` ≠ 研究市场时改成研究市场并写 `market_override:<原>→<新>`;永续 IR 进现货研究只允许做多且无杠杆,否则 `my_strategy_market:perp`。臂:code 臂去掉 judge(回到 v1);code_judge 臂 IR 自带 judge 就用它自己的问题与规则(`model_profile_ref` 钉到本次冻结 profile,reason `own_judge` / `own_judge:model_profile_rebound`),没有就附研究 spec 的 judge。有界持仓、每格空档、迭代环(diagnosis / neighborhood / swap 在该 IR 上改参;子代只拦新引入的规范阻断,父 IR 原有的不拦)、试验计数(同一研究谱系)、留出隔离与 Holm 全部沿用。adopt 这类 finalist 得到的是**该策略的新版本**(同 IR 哈希不重复建版本;`AdoptResult.strategy_id` = 原策略,`version` = 新版本;资产 / 周期与原登记不同时改成 finalist 的并写事件;策略已归档 → 409 `strategy_archived_conflict`),结论文案显示「名称」v<n>。前端:表单「策略」一行两组(我的策略多选 + 内置族),`#matrix-study?strategy=<id>` 预选;研究台内嵌矩阵研究的新建与最近列表;「我的策略」详情「在矩阵研究里测这条」跳该链接。

#### C. IR 判断要素 `judge` 块

唯一契约源为 `packages/contracts/schema/research.json`，按仓库 generate 流程生成类型。`StrategyIR.version=1` 禁止 `judge`，既有 JSON 不注入缺省字段、既有哈希不变；`version=2` 必须同时有 `order` 和 `judge`。两版共用既有 StrategyIR 根类型；纯代码策略仍用 v1。

```ts
interface StrategyJudge {
  version: 1;
  engine: 'jev' | 'llm';                 // 均适配 §9.52 DecisionClient；不选全局可变默认模型
  model_profile_ref: string;            // 钉住不可变连接/模型配置
  state_schema_version: 'judge_state_v1';
  questions: Array<{
    key: string;                       // ^[a-z][a-z0-9_]{0,47}$，唯一
    type: 'noul' | 'choice' | 'score';
    instructions: string;
    criteria: string[];                // noul 按 true,false；其它与 labels 同序
    labels?: string[];                 // choice/score 必填、唯一；score 为有序类别
    state_fields: JudgeStateField[];
  }>;
  rule: { all: Array<{
    question_key: string; label: string; operator: 'gte' | 'lte';
    threshold: number; margin: number;  // 均为 [0,1] 概率；不能把 score 位置当概率
  }> };
  on_error: 'skip'; on_uncertain: 'skip';
  max_attempts: 1; timeout_ms: number;   // 100..60000；一次未知收费请求不可重抽
}
type JudgeStateField = 'candidate.direction' | 'candidate.stop_distance_atr'
  | 'candidate.reward_risk' | 'features.trend' | 'features.volatility'
  | 'features.volume_ratio' | 'features.market_regime' | 'features.funding';
```

`FrozenModelProfile` 包含 `ref, connection_id, connection_revision, model, model_revision, routing, parser_version:'judge_answers_v1', max_call_usd, retry_policy:'none'`，不含凭证。`max_call_usd` 是供应商费用上界的十进制字符串；非 `offline_stub` 必须大于0。别名 `latest` 不能证明服务端权重不可变；没有稳定版本只能声明冻结配置与已录响应的一致性。owner 必须构造 `maxRetries:0` 的 client；`fromDecisionClient` 只能适配接口，不能替调用方关闭私有重试。

`buildJudgeState(candidate,bars,spec)`、`normalizeAnswers(spec,raw)`、`evaluateJudgeRule(spec,answers)` 为纯函数。state 只含 `version/as_of/timeframe_ms` 和问题选定的 candidate/features；固定取 as_of 前最近100根已收盘且已可用 bar，至少50根、连续无缺口。趋势为 SMA20/SMA50，波动为最近14根平均 true range/close，量比用20根均量，regime 为 up/down/volatile；不接任意对象路径、未来收益、全量数据对象或账户状态。funding 目前缺 as-of 适配，显式报 `judge_field_unavailable` 并 skip，不填0；盘口/live-only 特征不在首版白名单。金额、价格十进制字符串；时间 unix 毫秒整数；概率、比例为 number。

noul 归一成 yes/no，choice/score 必须有完整合法分布且和为1（容差1e-6）；score 接受有序标签或从0开始的索引概率键。规则是 `p-margin >= threshold` 或 `p+margin <= threshold`，全部满足才 follow；原始阈值满足但边距未满足为 uncertain→skip。首版不发布未经校准的盈利概率或默认阈值；离线桩的阈值只用于工程评测。问题、字段、阈值、边距只在开发视图调节，变更必须计入 matrix 试验账本。

```ts
judgeCandidate(input: Readonly<JudgeInput>, deps: JudgeDeps): Promise<JudgeResult>
// input: { candidate, state, spec, execution_spec_hash, model_profile, decision_key }
// deps: { mode:'recorded_only'|'request_once', store, budget, provider?, signal?, now? }
runWithJudge(env: EvalEnv, ir: StrategyIR, ir_key: string, window: Window,
  opts?: { runtime?: JudgeRuntime; on_candidate?: CandidateRecorder;
           execution?: Parameters<typeof runPool>[4] }): Promise<PoolRun & { candidates: CandidateLog[] }>
judgeFilter(ir: StrategyIR, runtime: JudgeRuntime):
  (candidate: JudgeCandidateSnapshot, bars: ResearchBar[]) => Promise<JudgeResult>
```

`JudgeRuntime` 在 deps 上增加 `model_profile/execution_spec_hash/scope`。`JudgeResult` 有 `status:ok|uncertain|error`、`action:follow|skip`、decision/state/request 哈希、raw_response_ref、归一回答、逐谓词证据、model_revision、latency_ms、cost_usd（未知为 null）、cost_status 与 reason_codes。orders/runPool 在代码意图生成后、模拟成交前过滤并保留全部候选；运行器 **auto/agent/confirm/signal_only 所有模式**通过 `StrategyRunDeps.judge(run,ir)` 注入同一实现，skip 也禁止候选 ASP 发布。无 judge 继续原行为；3m/5m 继续 blocker。

缓存分两层：request hash 绑定问题/顺序、状态、模型配置、超时和序列化版本，阈值变化可复用首次回答；decision key 另绑定规则、执行规范、候选与 scope，输入哈希冲突拒绝。`recorded_only` 缺响应返回明确 skip（不钉住缺失，便于随后合法采集）；request_once 原子 claim 后最多问一次，并发重复等待首次结果。响应已存而决策未存的崩溃，恢复从原响应计算；pending 不确定是否收费，确认旧 worker 已停止后 `interruptBudget` 转 unknown，保留预留，禁止重发。取消阻止新预留；resume 不清账。预留前取消或响应已存但尚未完成判断时的临时取消，不钉成最终策略决策；恢复可以进行首次请求或从原响应完成判断。claim成功后、decide前取消仍保守记unknown、保留预留且不重发。

0047 只建立以下 judge 表，不与已有 research_studies 或 matrix 表混用：

| 表 | 关键字段/约束 |
|---|---|
| research_call_budgets | id、max_calls/max_usd、calls/spent_usd/reserved_usd、cancelled/blocked；额度不可改，金额 TEXT |
| research_judge_responses | request_hash 主键、budget_id、request_json、raw_json、status pending/recorded/unknown、error_code、时间；首次非空 raw 不可覆盖 |
| research_call_attempts | attempt_id、唯一 request_hash、reservation_usd/actual_usd、usage_json、provider_request_id、status reserved/settled/unknown/overrun、时间 |
| research_judge_decisions | decision_id、唯一 decision_key、request_hash、input_hash/input_json、result_json、created_at；不可更新 |

`BEGIN IMMEDIATE` 内同时预留最大费用/调用数并 claim；响应和实际费用同事务落库。未知费用保留预留；供应商实际超过上界时照实记账并封锁后续调用。决策中的运营成本必须由上层账户评测计入，不能把累计查询费用当作单笔成交费。§9.52 最小接口只有解析后的 DecisionResult，因此此时钉住的是 **client 首次响应**；可选 `raw_response/provider_request_id` 扩展才提供供应商原文/对账 ID，缺少记 null，不伪造。judge 首版不新增 HTTP 路由，沿用策略 IR 保存/运行接口并供 matrix 服务内部调用；matrix 路由见 B。

**2026-09-25 astra 修订（仅 C）**：改为显式 IR v2 保持 v1 哈希；问题数组/字段白名单/概率谓词替代自由 features 与 score 数值比较；删除 fail-open 与未校准 DEFAULT_JUDGE；新增 immutable profile、灰区、首次响应与决策双层去重、原子预算四表、recorded_only/request_once；统一所有运行模式而非仅 agent；明确原始响应、重试、funding 与模型版本的首版限制。A 推荐资产及 B matrix 由对应实现者维护。

##### 2026-09-25 Jev 适配 v2

- **解析版本显式冻结**：`FrozenModelProfile.parser_version` 增加 `judge_answers_v2_rounding_001`。v1 的 `1e-6` 不变；v2 对完整、有限、每项在[0,1]的 choice/score 分布要求 `abs(sum-1) <= 0.01 + 1e-12`，随后逐项除以sum。0.99/1.01可接受，更大偏差拒绝；noul语义不变。新profile/ref进入请求哈希，不重写旧结果或暗中升级。E2E的51条原始分布尚未取得，默认仍v1；先脱敏统计再选择v2。
- **原始回答与费用**：客户端传`raw_response/provider_request_id`，解析失败与HTTP错误也保留已知usage并结算，cost支持十进制字符串，费用不依赖input_tokens合法。非JSON回答保存脱敏body_text；无响应的超时/断网无法伪造原文。已知未发送的请求拒绝记0，真实未知费用保留最大预留；错误分类可离线统计，不为追费用重抽。研究provider必须0重试。
- **live_only白名单**：`features.ob_imbalance_05`（midpoint±0.5%内所录档位名义额不平衡，[-1,1]）、`ob_wall_up/ob_wall_down`（`{price,notional}`十进制字符串，近价最大单档卖/买墙，price表达位置）、`spread_bps`、`liq_long_5m/liq_short_5m`（被清算long/short名义额十进制字符串）。盘口≤120秒且事件/可用时刻≤as_of；清算窗口(as_of−5m,as_of]必须有成功采集覆盖证明并去重。200档外不推断；OKX合约张数须乘冻结基础币ctVal。缺覆盖不填0。
- `buildJudgeState`第四参数可带`MicrostructureSnapshot`；`JudgeRuntime.microstructure`与`StrategyRunDeps.microstructure(symbol,as_of)`注入同一源。matrix可接录制器来源；依赖字段缺数据返回`judge_live_only_data_unavailable`，评估归为`DATA_MISSING`/insufficient_evidence（数据不可评）。gzip允许未结束流的完整前缀；旧录制缺接收时间与清算心跳，需可靠延迟上界/外部coverage证据，当前现拉结果不能回填历史候选。
- **价位与问题库**：新增`candidate.reference/support/resistance/stop/target`价格白名单，支撑阻力是最近两侧各2根已收盘bar确认的摆动点。`research/judge/templates.ts`含take、quality、support_holds、resistance_breaks、retreat_risk、regime_fit，价位事件固定未来15分钟；缺摆动或目标不可伪造。默认仍take+quality。matrix的`judge_templates:[{templates,rule?,microstructure?}]`每组合独立trial，训练段先评分选胜者再冻结进入选择/留出；迭代不重调模板/阈值，失败训练组合也计trial。不是已校准盈利概率。
- **G3四臂v2**：独立CLI `packages/gateway/scripts/research-study-eval/jev-g3.mjs`，≤3冻结候选，code/1h+4h便宜趋势/Jev/DeepSeek；同状态与问题语义、候选/资金/执行约束。DeepSeek直连`api.deepseek.com`/`deepseek-chat`；两key仅从运行环境读取。`--max-usd`强制≤2、`--approved-by Jacky`才允许真实采集；首次响应账本、独占锁、冻结manifest与预算、恢复不重复收费。真实预算以上界成立为前提，超上界实际照记并阻断。DeepSeek缺usage.cost时按冻结token单价保守估算并标来源，非账单核验。
- 分析需同冻结执行器导出的全部候选条件成交/每日净盯市路径，统一资金/风险/同资产冲突，扣调用日模型费；未成交候选显式记录not_filled，保留费用但不计实际开仓follow；UTC日配对差、10000次连续块bootstrap、块长≥持仓、跨finalist/两主要声明Bonferroni CI。6000候选、365天、100跟随、20有效块不足，桩、未知费用均报证据不足；DeepSeek探索性。旧六臂协议保留，四臂v2不伪造cash/matched_random。操作命令、runtime片段与限制见 `docs/research/jev-adapt-v2-2026-09-25.md`。

### 9.54 Agent 当前策略(一个策略概念)(2026-09-25)

设计 §3.1 / 验收 D2–D3、E2。Jacky 09-25 拍板:旧策略库 `StrategySpec` 退出实盘开仓路径;agent 的「当前策略」只有两种取值。

```ts
type AgentStrategyKind = 'free' | 'strategy';
interface AgentStrategyView {
  kind: AgentStrategyKind;             // free = 自由判断(playbook + 模型),strategy = 按一条研究策略运行
  strategy_id: string | null; version: number | null; name: string | null;
  run_id: string | null;               // kind=strategy 时对应的 StrategyRun(§9.51)
  run_status: StrategyRunStatus | null;
  mode: StrategyRunMode | null;        // 缺省 'agent'
  since: number | null;
  slices: BindingRoleSlice[];          // 该版本 binding 的六个角色片(radar/judge/geometry/risk/holding/execution),free 时为 []
  role_engines: Partial<Record<BindingRole, 'code' | 'decision' | 'llm'>>; // 楼层桌上标「谁在执行」:judge 片按 IR judge 块 → decision,否则按 §9.52 filter 角色 → llm
  legacy_pool_ignored: string[];       // 旧 active_strategies 里被忽略的 id(提示用,不再参与开仓)
}
```
路由:
- `GET /api/agent/strategy` → `AgentStrategyView`。
- `PUT /api/agent/strategy` `{kind:'free'}` | `{kind:'strategy', strategy_id, version?, mode?, symbols?, risk_pct?, max_open?, confirm?}` → `AgentStrategyView`。切到 strategy = 用 §9.51 runner.create/patch 起(或复用)该策略的运行并标记为 agent 当前策略;原当前策略的运行 → `stopped`(已开仓位按旧版本机械退出,与 §9.51 一致);实盘通道仍需 `confirm:'LIVE'`。切到 free = 停当前策略运行。
- SSE `agent.strategy`(data=AgentStrategyView)。

执行语义:
- `workflow.current_strategy: {strategy_id, version, run_id} | null` 持久化;启动时恢复。
- **kind=strategy 时,自由判断线不再开新仓**(thread_manager 只做已有线程复查、只读分析与旁白),避免两套大脑同时下单;kind=free 时按 playbook 自由判断(旧行为)。
- 旧库退出开仓:`effectivePoolIds` 恒为空 → 判断 prompt 不再注入 StrategySpec 规则(走 playbook);`active_strategies` 字段保留只读兼容,返回在 `legacy_pool_ignored`;allocator 自动轮换关闭。`#strategies` 旧页保留只读历史。
- StrategyRun 被 §9.51 以外的地方(策略详情页「运行策略」)单独启动的运行仍允许并存,但不是「当前策略」;楼层只显示当前策略。

前端:
- Agent 页顶部与楼层顶栏:「当前策略:<名字> v<版本> · <运行状态>」胶囊 + 「切换」弹层(自由判断 / 我的策略列表里能运行的策略,选中后显示预检 blockers/warnings 与运行参数,一键切换)。
- 楼层每张角色桌:悬停 / 点开显示它拿到的 binding 片(标题、summary、前 5 条规则 + 执行者标签:代码 / 决策模型 / LLM)。角色映射:radar 片 → radar 桌;judge 片 → thread_manager 桌;geometry + risk 片 → risk_sentinel 桌与 portfolio_manager 桌;holding 片 → thread_manager 桌第二栏;execution 片 → executor 桌。free 时桌上写「自由判断(playbook)」。

### 高级页面读取性能补充（2026-09-25）

- `/api/market/status`、`asp`、`subscriptions`、`search`、目录/ASP 详情的 GET 不等待外网：立即返回已有数据与 `cache: { fetched_at, stale, refreshing, state, error }`。时间为 unix 毫秒；首次无缓存 `fetched_at=null,state=loading`，失败保留旧成功快照并报告错误。刷新单飞、失败至少间隔 15 秒；展示缓存不参与订阅或交易授权，写入口仍实时核实。写操作、订阅/发布事件让展示缓存失效。
- 市场状态各远端区块独立刷新，另带 `sections` 元数据。目录主体沿用既有 `fetched_at/building/errors`，`cache` 指其订阅标记；`subscriptions_known=false` 表示尚无法确认订阅状态，前端不把它当作“未订阅”，禁用目录上的订阅/试用按钮。
- `GET /api/market-state/history?view=summary` 只返回时间线需要的 `id/as_of/bias/regime/summary/error`；不传 `view` 仍返回完整旧形状。
- `GET /api/logs?limit=100&before_id=<id>` 增加逐条 `id` 和响应 `next_before_id`（无下一页为 null）。游标来自折叠前原始末行，重复告警折叠不会导致翻页重复。
- `GET /api/activity?limit=50&before=<at>&before_id=<id>` 增加 `next_before: {at,id}|null`，按 `(at,id)` 倒序翻页，保留旧的仅 `before` 调用。日志页两块独立加载、限制单页渲染，关键词/组别筛选范围为当前页；最新页每 5 秒更新，历史页固定。
- 不轮转、不删除历史记录。本次只补查询索引与增量回填进度；历史存储的长期归档可另行制定。

### 9.55 Agent 名册、身份、循环与规范线程(2026-09-25)

设计 docs/design/agent-roster-chat-2026-09-25.md。九个 agent = `BOT_ROLES`;每个 agent 一条规范线程,楼层对话框与 Agent 页读写同一个 session id,靠现有 SSE `chat.message` 同步。

```ts
type AgentChatState = 'idle' | 'queued' | 'thinking' | 'tool' | 'error';
type LoopNodeKind = 'trigger' | 'read' | 'code' | 'model' | 'gate' | 'handoff' | 'output' | 'human';

interface AgentCard {
  role: BotRole;                 // 九个之一,顺序 = 注册表顺序
  name: string;                  // "ASP Agent"
  callsign: string;              // HELM RADAR THREAD LAB BOOK SENTINEL AUDIT EXEC MARKET
  tagline: string;               // 一句话「我是谁」
  enabled: boolean;              // bot profile 开关
  session_id: string;            // gate_captain → "default";其余 → "agent:<role>"
  message_count: number;
  last_message_at: number | null;   // 可为 null
  last_text: string | null;         // 可为 null
  chat: { state: AgentChatState; tool: string | null; since: number | null };
  loop: {
    cadence: string;             // 人话:「每 30 分钟」「事件触发」
    status: 'idle' | 'running' | 'paused' | 'disabled' | 'error';
    current_node: string | null; // running 时 = graph 节点 id
    last_run: { id: string; routine: string; status: string; started_at: number; finished_at: number | null; summary: string | null } | null;
    next_run_at: number | null;  // 可为 null(算不出)
    pending_handoffs_in: number;
  };
  tools: { name: string; group: 'read' | 'research' | 'act' | 'config'; summary: string }[];
}

interface AgentGraph {
  entry: string;
  nodes: { id: string; label: string; kind: LoopNodeKind; to_role?: BotRole | null }[];
  edges: { from: string; to: string; label?: string | null }[];
}
```

- `GET /api/agents` → `{ agents: AgentCard[] }`(恒 9 条)。
- `GET /api/agents/:role` → `{ agent: AgentCard, agent_md: string, graph: AgentGraph, recent_runs: AgentCard['loop']['last_run'][], handoffs: { in: BotHandoff[], out: BotHandoff[] } }`;未知 role → 404 `unknown_role`。`agent_md` 的固定二级标题:我是谁 / 我负责 / 我不负责(找谁) / 红线 / 我的循环 / 我能调的工具 / 口径。
- `POST /api/chat/sessions { role }` → 幂等返回该 agent 的规范会话(不再新建)。不带 role 照旧新建自由会话。
- `ChatSession` 增加 `canonical: boolean`;规范会话归档/删除 → 409 `canonical_session`,只能 `POST /api/chat/reset { session }` 清空。
- SSE 新事件 `chat.status`:`{ session_id: string, role: BotRole | null, state: AgentChatState, tool: string | null, at: number }`。
- 白名单外工具调用 → 工具结果 `{ error: "not_my_tool: <tool> 属于 @<CALLSIGN>" }`(模型会转述给用户)。
- 新增 ASP 只读工具(只给 asp_agent;gate_captain 只拿 get_asp_overview):get_asp_overview / list_asp_services / list_asp_tasks / list_asp_subscribers / list_market_inbox。前端 `toolAction` 需要这几个名字的中文动作。

### 9.56 交易页三层：来源 / 判断 / 执行(2026-09-27)

交易页按三层看一笔单子从哪来、谁决定做不做、代码怎么执行：

1. **机会来源**：AI 扫盘（模型按 playbook 看盘）；策略运行（代码在收盘时扫出候选，可以同时开多条）。
2. **判断层**：每个来源选一种。AI 扫盘固定是模型判断；策略运行的 `mode` 可选 `auto`（直接做）、`agent`（LLM 判断）、`jev`（Jev 判断）、`signal_only`（只发信号）。「每笔问我确认」（`confirm`）已下线。
3. **执行层**：全部由代码执行，所有来源用同一套参数：每笔风险 × 组合经理倍率、止损底线（按百分比或按 ATR，见 9.56.11）、止损上限、净盈亏比、同币只开一条、同时持仓上限、每日开仓次数、日亏停、杠杆。

执行层的阈值只有一个来源：`packages/gateway/src/demo/execution-policy.ts` 的 `executionThresholds(workflow)`。实盘开仓检查、策略运行开仓、运行预检、研究回测都读它，所以回测能下的单，实盘用同样的参数也能下。

#### 9.56.1 workflow 新字段

| 字段 | 类型 | 默认 | 人工可调 | 说明 |
|---|---|---|---|---|
| `stop_floor_mode` | `'pct'` \| `'atr'` | `'pct'` | pct / atr | 止损底线按百分比还是按 ATR 算（2026-09-27 下午新增，见 9.56.11） |
| `stop_floor_atr_tf` | `'15m'` \| `'1h'` \| `'4h'` | `'1h'` | 三选一 | ATR 模式用哪个周期的 ATR14 |
| `min_stop_pct` | number | 1.0（原 0.3） | 0.2–5 | 止损距离下限，入场价的百分比；**只在 pct 模式生效** |
| `max_stop_pct` | number | 5 | 1–15 | 止损距离上限；两种模式都生效 |
| `min_stop_atr` | number | 1.0（原 0.5） | 0–3 | 止损至少是 k × `stop_floor_atr_tf` 那根的 ATR14；**只在 atr 模式生效**，0 表示关掉下限（只剩上限） |
| `min_net_rr` | number | 1.5 | 0.5–5 | 扣掉来回成本（12bps）后的盈亏比下限 |
| `ai_scan_paused` | boolean | false | — | 只暂停 AI 扫盘，见 9.56.5 |

- 越界时 `POST /api/workflow` 返回 errors，不会悄悄改成边界值；`min_stop_pct` 必须小于 `max_stop_pct`。
- 老库缺这些字段或存了坏值，读出来是默认值。
- 一次性迁移（网关启动时，见 9.56.11）：库里 `min_stop_pct` 恰好是旧默认 0.3、`min_stop_atr` 恰好是旧默认 0.5、而且没有 `stop_floor_mode` 的，改成 1.0；`playbook_text` 与旧出厂 playbook 逐字相同的换成新默认。人改过的值不动。
- `max_open_threads` 可调上限从 6 放宽到 20，`max_opens_per_day` 从 12 放宽到 50。
- `min_net_rr` 的优先级：执行层的值是下限。旧策略库里的 `params.min_net_rr` 只能把它调高，不能调低（取两者较大值）。§9.54 之后旧策略库已不再开仓，这条只影响已有的持仓计划。

#### 9.56.2 `GET /api/execution-policy`

```jsonc
{
  "values": {
    "risk_pct": 0.5, "leverage": 3, "margin_mode": "cross",
    "stop_floor_mode": "pct", "stop_floor_atr_tf": "1h",
    "min_stop_pct": 1, "max_stop_pct": 5, "min_stop_atr": 1, "min_net_rr": 1.5,
    "max_open_threads": 3, "max_opens_per_day": 4, "daily_loss_stop_pct": 3,
    "sizing_agent": "apply"
  },
  "bounds": {
    // 数值键
    "min_stop_pct": { "min": 0.2, "max": 5, "step": 0.05, "agent_direct_min": 0.5, "agent_direct_max": 3, "integer": false },
    // 枚举键
    "margin_mode": { "values": ["cross", "isolated"], "agent_direct_values": ["cross", "isolated"] },
    "stop_floor_mode": { "values": ["pct", "atr"], "agent_direct_values": ["pct", "atr"] },
    "stop_floor_atr_tf": { "values": ["15m", "1h", "4h"], "agent_direct_values": ["15m", "1h", "4h"] }
    // …每个 values 里的键都有一项
  },
  "backend": "paper",            // 当前执行通道
  "execution_label": "纸面",
  "live": false,                 // 是否真钱(纸面和交易所模拟盘都是 false)
  "usage": { "open_threads": 1, "max_open_threads": 3, "opens_today": 2, "max_opens_per_day": 4, "daily_loss_hit": false },
  "updated_at": 1790000000000,
  // 2026-09-27 下午新增:止损百分比 ↔ ATR 换算,给「按 ATR 设止损」的界面显示折算和打到止损亏多少
  "stop_conversions": [
    { "symbol": "BTCUSDT", "price": "65000.1",
      "atr_pct": { "15m": 0.21, "1h": 0.55, "4h": 1.3 },   // ATR14 占价格的百分比;取不到的是 null
      "floor_pct": 1,          // 当前模式下这个币实际的最小止损百分比:pct 模式 = min_stop_pct;atr 模式 = min_stop_atr × atr_pct[stop_floor_atr_tf](取不到 ATR 时 null)
      "as_of": 1790000000000,  // 这一行用到的 ATR 里最旧的那个的获取时间;都没有时 null
      "stale": false }         // 价格或任一周期 ATR 缺失
  ],
  "stop_conversions_as_of": 1790000000000,
  "stop_conversions_stale": false,   // 任一行 stale 就是 true
  "risk_per_trade_usdt": "50.00"     // 权益 × risk_pct,打到止损大约亏多少(手续费和滑点另算);没有账户权益时 null
}
```

- `stop_conversions` 覆盖 `watchlist` 里的每个币（永续），从网关已有的行情缓存算（AI 扫盘、K 线收盘触发器、止损底线检查顺手记下的 ATR；同一根 K 线收盘前复用）。缓存缺的在后台补拉，最多等 0.8 秒，等不到的记 `null` 并标 `stale`；整个计算超过 1 秒则 `stop_conversions: null`、`stop_conversions_stale: true`。接口不会因此明显变慢。
- 价格优先用标记价缓存，没有时用 K 线收盘价。访客可读，没有敏感字段。

`values` 里 `risk_pct`、`daily_loss_stop_pct` 是数字（workflow 里存的是字符串）。

各键的边界：

| 键 | 人工 min–max(step) | agent 直改区间 |
|---|---|---|
| risk_pct | 0.1–2 (0.05) | 0.1–2 |
| leverage | 1–10 (1，整数) | 1–10 |
| stop_floor_mode | pct / atr | 都可以 |
| stop_floor_atr_tf | 15m / 1h / 4h | 都可以 |
| min_stop_pct | 0.2–5 (0.05) | 0.5–3 |
| max_stop_pct | 1–15 (0.5) | 2–10 |
| min_stop_atr | 0–3 (0.1) | 0.3–2 |
| min_net_rr | 0.5–5 (0.1) | 1.2–3 |
| max_open_threads | 1–20 (1，整数) | 1–10 |
| max_opens_per_day | 1–50 (1，整数) | 1–20 |
| daily_loss_stop_pct | 0.5–20 (0.5) | 1–10 |
| margin_mode | cross / isolated | 都可以 |
| sizing_agent | off / advise / apply | 都可以 |

#### 9.56.3 `PATCH /api/execution-policy`（人工修改）

请求体：要改的键，外加实盘时的 `confirm`：`{ "min_stop_pct": 0.5, "min_net_rr": 1.8, "confirm": "LIVE" }`。

- 按上表人工区间校验，有一个键不合法整单不生效，返回 400：`{ "error": { "code": "invalid_policy", "message": "…" }, "errors": [{ "key", "code", "message" }] }`。`errors[].code` 取值：`unknown_key`、`invalid_type`、`out_of_bounds`、`not_integer`、`invalid_range`（上下限颠倒）。
- 实盘通道（`live: true`）必须带 `confirm: "LIVE"`，否则 409 `live_requires_confirm`。模拟盘带了也不影响。
- 成功返回 200：`{ "policy": <同 GET>, "errors": [] }`，并推 SSE `workflow.changed`。
- 权限和 `POST /api/workflow` 相同：写请求只接受本地页面来源，其它浏览器来源 403。本分支网关没有访客/owner 区分，公网演示版的只读由前端构建开关和评审分支处理。

#### 9.56.4 agent 工具

| 工具 | 分组 | 给谁 | 语义 |
|---|---|---|---|
| `get_execution_policy{}` | read | gate_captain、thread_manager、portfolio_manager、risk_sentinel、executor | 返回和 GET 一样的内容；`stop_conversions` 只读缓存、不补拉 |
| `set_execution_policy{"patch":{…}}` | config | gate_captain、portfolio_manager、risk_sentinel | 见下 |

`set_execution_policy` 的结果：

- 模拟盘，且每个键都在 agent 直改区间内：直接生效，写日志和活动流，返回 `{ ok: true, applied: true, mode: "direct", errors: [], policy }`。
- 超出直改区间，或当前是实盘：不生效，生成一张设置提议卡（和 `set_workflow` 同一套 `WorkflowProposal`，用户在界面上确认），返回 `{ ok: true, applied: false, mode: "proposal", reason: "outside_agent_direct" | "live_requires_human", outside_agent_direct: [键], proposal: { id, status, keys, before, after, errors } }`。
- 参数不合法：`{ ok: false, applied: false, mode: "rejected", errors: [...] }`。

`set_workflow` 仍然拒绝风险、杠杆、上限、止损、净盈亏比、日亏停、仓位倍率这些键，返回的 `note` 提示改用 `set_execution_policy`。`ai_scan_paused: true` 直接生效，`false` 要生成提议（和 `paused` 一样）。`set_execution_policy` 不进公网访客的对话工具白名单。

#### 9.56.5 AI 扫盘单独暂停

- `PATCH /api/trading/sources/ai_scan`，请求体只能是 `{ "paused": true | false }`，否则 400 `bad_request`。返回 `{ "source": <9.56.6 里的 ai_scan 对象> }`。权限同策略运行的暂停（`PATCH /api/strategy-runs/:id`），公网访客可以改。
- 暂停后不再扫描找新机会（定时、心跳、急涨急跌、对话里的 run_scan 都不扫），排队中的扫描跑完也不开仓（开仓检查多一行「AI 扫盘已暂停」，code `ai_scan_paused`）。已有线程照常复查，策略运行不受影响。
- 也可以用 `POST /api/workflow { "ai_scan_paused": true }`。`workflow.paused` 仍然是全部暂停。

#### 9.56.6 `GET /api/trading/sources?since=<ms>`

- `since` 默认今天 UTC 零点；必须是不晚于现在、不早于 31 天前的毫秒时间戳，否则 400 `bad_request`。
- 只读、零模型、没有敏感字段，公网访客可读（不在 privateApi 列表里）。

```jsonc
{
  "since": 1790000000000, "until": 1790030000000,
  "shared": { "open_threads": 1, "max_open_threads": 3, "opens_today": 2, "max_opens_per_day": 4,
              "daily_loss_hit": false, "halted": false, "paused": false },
  "sources": [
    {
      "kind": "ai_scan", "id": "ai_scan", "name": "AI 扫盘",
      "enabled": true,                // 没急停、没暂停、AI 扫盘没暂停、Thread Manager 开着、没被 agent 当前策略接管
      "disabled_reason": null,        // enabled=false 时的原因文字
      "paused": false,                // ai_scan_paused
      "playbook": { "name": "突破-回踩(单一策略,v3)", "prompt_version": "demo-playbook-v11.1-ohlc", "custom": false },
      "judge": "model", "timeframe": "15m", "symbols": ["BTCUSDT"], "scan_mode": "triggered",
      "budget": { "judgments_used_today": 42, "judgment_cap": 300 },   // 全局每日判断额度(本地日)
      "today": {
        "judgments": 40,              // 窗口内 AI 扫盘调模型的次数
        "actions": { "NO_TRADE": 30, "WATCH": 6, "PROPOSE": 4 },
        "proposals": 4, "gate_rejected": 3, "orders": 1, "pending_approval": 0, "failed": 0
      },
      "last_event": { "at": 1790029000000, "symbol": "SOLUSDT", "action": "NO_TRADE", "summary": "…" },
      "top_reasons": [ /* TopReason[],只有被挡的 */ ],
      "not_taken": [ /* TopReason[],没做但不算被挡 */ ]
    },
    {
      "kind": "strategy_run", "id": "run_…", "run_id": "run_…", "strategy_id": "rs_…", "name": "SOL 15m 回踩", "version": 3,
      "symbols": ["SOLUSDT"], "timeframe": "15m",
      "mode": "jev",                  // auto | agent | jev | confirm(老运行) | signal_only
      "judge": "jev",                 // code(auto/confirm) | llm(agent) | jev | none(signal_only)
      "status": "running", "enabled": true, "market": "perp", "risk_pct": 0.5, "max_open": 3,
      "execution": { "backend": "paper", "profile": null, "label": "纸面" },
      "today": { "scans": 12, "candidates": 4, "judged": { "follow": 2, "skip": 2 }, "gate_rejected": 2,
                 "skipped": 1, "orders": 0, "open_threads": 0, "errors": 0 },
      "last_event": { "at": 1790029000000, "kind": "order_rejected", "symbol": "SOLUSDT", "message": "…" },
      "top_reasons": [], "not_taken": []
    }
  ]
}
```

策略运行列出所有没停的运行，加上窗口内有事件的已停运行。

`TopReason`：`{ layer: "judge" | "strategy" | "gate" | "execution", key: string, label: string, count: number, example: string }`，按 count 倒序，最多 8 条。`example` 是一条原文（最多 200 字）。

原因码（`key`）：

| layer | key | 含义 |
|---|---|---|
| gate | stop_distance | 止损距离低于 `min_stop_pct` |
| gate | stop_atr | 止损小于 `min_stop_atr` × ATR |
| gate | stop_too_wide | 止损距离超过 `max_stop_pct` |
| gate | min_net_rr | 净盈亏比不够 |
| gate | max_open_threads / max_opens_per_day / daily_loss_stop / symbol_open | 同时持仓满、今日开仓满、日亏停、同币已有线程或持仓 |
| gate | portfolio_limit / risk_sentinel / sizing | 组合限额、风控告警、数量不可用 |
| gate | stop_side / tp_side / stale / position_exists / confidence / spot_no_short / market_not_enabled | 止损或止盈方向错、行情过期、本币已有持仓、信心不足、现货不能做空、市场没开 |
| gate | current_strategy / unknown_order / council / entry_style / event_blackout / tier_limit / holding_atr / invalidation / holding_plan / preflight / other_gate | 其它开仓检查 |
| strategy | already_open / max_open / ambiguous_position / min_rr / position_unsettled / new_signal | 本运行已有该币、本运行持仓满、同币多条线程、候选盈亏比低于策略要求、同币线程待核对、新信号等旧单结束 |
| judge | agent_skip | LLM 判断 agent 说跳过 |
| judge | ir_judge_skip | 策略自带的判断要素（IR judge 块）说跳过 |
| judge | jev_skip / jev_unavailable | jev 模式下 Jev 说跳过 / Jev 调不到、超时或预算用完 |
| execution | execution_unknown / execution_error / model_failed | 回执未知、执行出错、模型调用失败 |
| 任意 | `text:<去掉数字的原文>` | 旧事件认不出的原因，`label` 就是原文 |

`not_taken` 用的 key（不算被挡）：`no_trade`、`watch`（模型判断不做/观察）、`halted`、`paused`、`ai_scan_paused`、`transient`（临时失败，稍后重试）、`screen_filter`、`bars_pending`（行情还没到）、`entry_expired`（限价单过期没成交）、`entry_unknown_not_found`。

计数规则：一条 AI 提议同时没过几项检查，每个原因码各计一次；IR 判断要素跳过时运行器会记 `agent_skip` 和 `skip: ir_judge_skip` 两条事件，汇总只算一次。

#### 9.56.7 事件里的结构化原因（源头写入）

- 策略运行事件 `skip`、`agent_skip`、`agent_follow`、`order_rejected`、`error` 的 `data` 新增 `layer`、`code`；`order_rejected` 还带 `gates: GateResult[]`（原样，不拼成字符串）。`GateResult` 新增可选 `code`。
- AI 扫盘：episode 的 `gates[]` 每一项带 `code`；活动流 `proposal_blocked` 的 `data` 新增 `layer: "gate"`、`code`（第一个没过的检查）、`gates`（没过的检查原样）。
- 旧事件没有这些字段，`/api/trading/sources` 按文字归类。

#### 9.56.8 判断层：运行模式

- `POST /api/strategy-runs`、`PATCH /api/strategy-runs/:id`、`PUT /api/agent-strategy` 传 `mode: "confirm"` 返回 400 `mode_confirm_removed`。已经存在的 confirm 运行照常跑，也能改别的参数，不做迁移。
- 新模式 `jev`（策略没有 IR judge 块时）：每个候选先问 Jev（默认题目 take + quality，和影子判断同一套），Jev 说跟才开仓，记 `agent_follow`（`code: jev_follow`）；说跳过记 `agent_skip`（`code: jev_skip`），不下单；决策模型没绑定、预算用完、出错、30 秒没回答，都记 `agent_skip`（`code: jev_unavailable`，message 里写原因），不下单。判断账本 `judge_live_decisions` 这一行 `mode: "gate"`，每个候选一行；预算按运行、按 UTC 日计（作用域 `live:jev:<run>:<day>`，上限同影子判断：200 次、0.03 美元）。jev 模式不再额外做影子判断。
- 策略带 IR judge 块时，不管什么模式都由 judge 块判断，和以前一样。
- `GET /api/agent-strategy` 的 `role_engines.judge`：jev 模式为 `decision`。

#### 9.56.9 执行层接到策略运行

- 策略运行开仓现在和 AI 扫盘用同一套执行层：止损底线和上限（读 workflow，按 9.56.11 的模式判；ATR 模式取 `stop_floor_atr_tf` 最近已收盘 K 线的 ATR14，取不到时改按百分比判）、净盈亏比。净盈亏比按入场价（限价用挂单价，市价用现价）和止盈目标算；分档止盈按各档仓位比例加权成一个等效目标（30% 在 1R、70% 在 3R 相当于 2.4R）；没有止盈目标（只靠信号或时间离场）不判净盈亏比。被拒时 `order_rejected` 的 message 仍以 `基础闸拒绝:` 开头，`data` 带 `layer: "gate"`、`code`、`gates`。
- **组合经理倍率也作用于策略运行**：固定风险的运行在 `sizing_agent` 不是 `off` 且组合经理开着时，开仓前问一次仓位意见，倍率 0.25–2 乘在运行自己的 `risk_pct` 上；模型失败或超时（10 秒）按 1 倍。下单前最后一次数量检查用同一个倍率复核，数量上限、最小名义、流动性上限都不变。波动率目标（vol_target）的运行不接倍率：它的数量只由 `sizeRunOrder` 算，乘倍率会改掉它的单笔风险上限。代价：每个通过检查的候选多一次便宜模型调用（不占每日判断额度），开仓前最多多等 10 秒；按金额算的收益和回测会差一个倍率，按 R 算的不变。
- 预检 `GET /api/strategy-runs/preflight` 新增：
  - `execution_policy_mismatch`：回测（或历史候选）按当前执行层会被拒的比例。回测样本被拒 ≥50% 是 blocker，其它情况是 warning；只能用同版本实盘候选核对时只给 warning（运行时本来就会逐单拒掉并记原因）。message 例：`回测订单按当前执行层会被拒掉 60%(3/5:止损低于下限 3),样本止损中位 0.18%;建议把策略止损倍数放宽到 ≥0.8×ATR(按样本 ATR 中位 0.40%,约 0.32%)`。建议只说怎么改策略，不建议调低执行层下限。
  - `execution_policy_changed`（warning）：新回测报告里记下的阈值和现在不同，提示重跑回测。
  - `execution_unverified`（warning）：找不到这个版本的回测订单或实盘候选，无法核对。
  - 样本来源优先级：新回测报告的 `execution_gate` 计数 → 旧报告的订单计划（`assets[].plans`，止损、止盈、数据集算的 ATR）→ 同策略同版本运行的 `candidate` 事件。

#### 9.56.10 研究回测也按执行层拒单

- 研究回测（全窗口回测报告，默认执行器和订单周期执行器）和研究 run 在下单决策时用同一套阈值判断，被拒的候选不下单。阈值默认取 workflow 当前值（没接上就用默认值）。
- 冻结的阈值仍是契约 `ExecutionGateThresholds` 的 5 个数，止损底线的模式靠数值表达（9.56.11）：pct 模式存 `min_stop_atr: 0`；atr 模式存 `min_stop_pct: 0`，`min_stop_atr` 换算到回测周期；两个都大于 0 的是 09-27 下午之前的快照，按原规则两条都判。
- 用到的阈值存进结果里，重放按存下的值，不再读 workflow：研究 run 存在 `manifest.request.order_gate.execution_thresholds`（请求显式传 `null` 表示不按执行层拒单；幂等键不变）；回测报告存在 `execution_gate.thresholds`。
- `BacktestReport.execution_gate` 和每个 `BacktestAsset.execution_gate`（篮子是两条腿之和，报告顶层是各单资产之和）：

```jsonc
{
  "version": "exec-gate-v1",
  "thresholds": { "min_stop_pct": 1, "max_stop_pct": 5, "min_stop_atr": 0, "min_net_rr": 1.5, "round_trip_cost_bps": "12" },   // pct 模式的快照
  "checked": 310,       // 进入执行层判断的候选数
  "rejected": 225,      // 被拒的候选数(去重)
  "rejected_by_execution": { "stop_distance": 93, "stop_atr": 0, "stop_too_wide": 0, "min_net_rr": 225 },  // 一个候选可以同时命中几项
  "examples": [{ "symbol": "SOLUSDT", "at": 1790000000000, "reason": "…" }]   // 最多 5 条
}
```

- `execution_gate` 为 `null` 或没有这个字段：这份报告是旧的，回测时没按执行层拒单，前端显示「这份回测没按执行层拒单」。旧报告不重算。
- 订单计划被执行层拒掉时 `status: "blocked"`，`blocked_reason` 是四个原因码之一。
- 改进环（`improve/evaluate.ts`）和 ASP 快速回测（`quick-backtest.ts`）暂时仍不按执行层拒单，它们不产出报告。
- 实盘候选生成（`generateRunCandidate`）不按执行层过滤，候选照常出来，由执行层在下单时拒掉并记在漏斗里。

#### 9.56.11 止损底线两种模式（2026-09-27 下午）

背景：参照带单员 72 笔开仓，止损中位 1.72%，一半在 1.3%–2.3%，最窄 0.64%，约合 2.3×1h ATR 或 1×4h ATR。原来 0.3% 的底线太窄。默认按百分比说止损，用户可以切到 ATR。

- **pct 模式**（默认）：止损距离 ≥ `min_stop_pct`（默认 1%）。ATR 只用来显示倍数，不参与判断。
- **atr 模式**：止损距离 ≥ `min_stop_atr` × `stop_floor_atr_tf` 那根的 ATR14（默认 1×1h ATR），百分比底线不生效。取不到 ATR（行情缓存里没有、补拉失败）时改按 `min_stop_pct` 判，原因里写「ATR 不可用,改按百分比」。`min_stop_atr: 0` 表示关掉下限。
- `max_stop_pct` 两种模式都判。
- 判定只有一个函数 `stopGeometry`（`execution-policy.ts`），这些地方都调它：AI 扫盘开仓检查、策略运行开仓、订阅信号开仓、对话提议、发送前复查、策略运行预检（`execution_policy_mismatch`）、研究回测（`research/execution-gate.ts`）。
- ATR 从哪来：AI 扫盘用这次扫盘已经拉好的特征（atr 模式时把 `stop_floor_atr_tf` 加进拉取计划）；策略运行、订阅信号、对话提议、发送前复查读网关的 ATR 缓存，缓存里没有当前这根才拉一次（同一键同时只拉一次，失败 60 秒内不重试）。pct 模式不为止损底线拉 K 线。
- 研究回测只有信号周期的 ATR：atr 模式的倍数按「波动随时间开根号」换算到回测周期（1×1h ATR ≈ 2×15m ATR ≈ 0.5×4h ATR，保留计算精度，避免把正数下限舍入成 0）后冻结，报告警告里写明换算；策略运行预检用同一换算和回测快照比较。
- 当前五字段回测快照不能同时保存 ATR 模式和自定义百分比回退值：ATR 数据缺失时回测使用默认 1%，可能与运行设置不同。保留自定义回退值需要扩展 `ExecutionGateThresholds` 契约；策略运行预检的样本检查保留当前设置中的百分比。
- 原因码与文字：

| 模式 | 检查项名 | code | reason 例 |
|---|---|---|---|
| pct | 止损距离 | `stop_distance` / `stop_too_wide` | `0.60%(允许 1%–5%)` |
| atr | 止损ATR下限 | `stop_atr` | `0.73×ATR(下限 1×1h ATR ≈ 0.55%;距离 0.40%,上限 5%)` |
| atr | 止损距离 | `stop_too_wide` | `7.00%(上限 5%)` |
| atr 取不到 ATR | 止损距离 | `stop_distance` | `ATR 不可用,改按百分比:0.60%(允许 1%–5%)` |

- 发送前复查（新增）：发单前用新鲜价格再判一次止损底线和上限（限价单按挂单价和现价里对自己更不利的那个），不过就不发，线程关闭原因 `发送前止损复查:止损距离|止损ATR下限|止损过宽 <reason>;原计划不改价`，原因码分别是 `stop_distance` / `stop_atr` / `stop_too_wide`。批准到发送之间把底线调宽了，已批的单会在这里被拦下。
- 提示词：规则 5 按当前模式写具体数值（「止损至少 1.00%,不超过 5%」或「止损至少 1×1h ATR(当前 BTC≈0.55%),不超过 5%」）；没绑策略的 AI 扫盘多一条计划证据「止损底线(代码核验)」，说明和「可选ATR尺度」两条都要满足、按更宽的放。提示词版本 `demo-playbook-v11.2-stopfloor`。持仓计划的 ATR 尺度检查（没绑策略时 ≥1×1h ATR）不变。
- 出厂 playbook 的止损句改为「止损放在最近结构位(swing 低/高)之外,至少 1%(波动大的币按规则里的 ATR 下限放得更宽);第一止盈至少是止损距离的 1.5 倍,可给第二止盈」。
- 一次性迁移（网关启动时执行一次）：
  - 库里 `min_stop_pct === 0.3` 且没有 `stop_floor_mode` → 改成 1.0；`min_stop_atr === 0.5` 且没有 `stop_floor_mode` → 改成 1.0。迁移后存成 `stop_floor_mode: "pct"`，下次启动不再触发。
  - `playbook_text` 与旧出厂 playbook 逐字相同 → 换成新默认；改过一个字都不动。
  - 有改动时记一条活动 `workflow_changed`（`level: warn`，`data.via: "migration"`，`data.changes: [{ key, from, to }]`）并写日志。
- 英文文案之后由评审分支补。
