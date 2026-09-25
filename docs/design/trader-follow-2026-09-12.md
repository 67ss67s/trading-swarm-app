# 跟单 session(Trader Follow):交易员开单 = 触发,agent 决定跟 / 不跟 / 只当证据

日期 2026-09-12。Jacky 拍板:"有交易员开单的时候做一个 trigger 并且决定是否 apply 或者做一个依据","bridge 订阅和打包 API 都用"。
前置研究:`docs/research/trader-study-2026-09-12.md`(结论:方向无优势、点位有执行优势但触及率低、**发布时机有信息**)、`docs/research/copy-engine-rules-from-8794-2026-09-12.md`(8794 跟单规则清点)、`docs/research/bridge-and-stats-api-2026-09-12.md`(bridge 订阅协议 + 8794 统计接口)。`docs/design/trader-twin-2026-09-12.md` 的"不许偷看"只保留给影子腿的对照统计,跟单腿是明确让 agent 看信号的。

## 0. 口径

- **触发源** = bridge 订阅拉到的结构化信号(`GET /api/v1/subscriber/signals`,after_id 游标 + 长轮询,`X-API-Key`/`X-Secret-Token`,自定义 UA)。只有 `action_type ∈ {open, add}` 产生新触发;`reduce/close/cancel/stop_loss_update/take_profit_update/stopped_out` 是**管理动作**,路由到已关联线程。
- **权重源** = 本机 8794(`http://127.0.0.1:8794/api/copytrading/trader-stats`,无鉴权;夏普只在 strategy-public-api 有,本地不依赖)。权重只影响仓位与默认模式,**不影响触发本身**。
- **三种模式**,按交易员配置,默认 `gated`:
  - `copy`:照抄。入场区、止损、分档止盈原样进线程,只过 trading-swarm 自己的闸(preflight、entry_style、黑窗、名义上限、每日开仓上限)。
  - `gated`:agent 把关。信号作为证据挂到一次 `scan` episode,agent 给 stance;同向 → 用信号的止损/止盈几何开线程(agent 自己的止损更紧则取 agent 的);反向或 flat → 不开,记 reason code;仓位 = 权重 × workflow.risk_pct。
  - `evidence`:只进证据与判断账本,不开线程,不改 active。
- **仓位**按风险算(`risk_pct × weight`),不用交易员的"2% 保证金 100 倍"——那不是可比的风险权重(研究报告 §1 交易员A节)。
- **新鲜度**:live 信号 `published_at` 距今 > `freshness_s`(默认 180s)只能 `evidence`;启动补拉(backfill)一律 `review_only`,永远不自动开仓(8794 同款)。
- **止损必需**:open/add 没有止损的信号不进 `copy`/`gated`,降级为 `evidence` 并记 `trader_signal_no_stop`(交易员C 341 条无止损就是这个归宿)。

## 1. 数据流

```
bridge /subscriber/signals ──trader-feed.ts(游标 kv、退避、DLQ)──▶ demo_trader_signal(0022)
        │ open/add                                      │ 管理动作
        ▼                                               ▼
  TriggerKind 'trader_signal' ──runEpisode(scan)──▶ 线程(origin trader:X)  ◀── 按 ref_signal_id / trader+symbol 关联 ──▶ close/reduce/移损/撤单
        │
        ├─ copy    → openThreadFromSignal(复用手动开仓链:止损校验、名义上限、preflight)
        ├─ gated   → agent 判断 → 同向开 / 反向跳过(reason code)
        └─ evidence→ 判断账本 source='trader' + 议会证据
8794 /trader-stats ──trader-stats.ts(每小时)──▶ 权重 ──▶ 仓位倍数 / 前端卡片
```

## 2. 规则(从 8794 移植的,标 [8794])

入场:
- 区间取价 [8794]:做空取区间**最大值**,做多取**最小值**(更容易成交的一侧);多价位阶梯均分,单价 100%。
- 市价意图 [8794]:不发裸市价,按"顶着偏离上限的限价"下(BTC/ETH 0.3%、其余 0.5%),超限过期不追;与现网 `entry_style=limit_only` 一致。
- 限价距 mark 超过 0.55% 拒 [8794];限价不得比 mark 更激进超过 0.05% [8794]。
- 重复开仓 [8794]:同交易员同币已有活线程 → `duplicate_open` 跳过;原单入场腿全部终态未成交 → 视为已死,允许再入场。
- 反向敞口 [8794]:同币已有反向线程 → 拒,记 `trader_reverse_exposure`。

管理:
- `close` / `stopped_out` → 平线程(copy 与 gated 都自动;离场纪律强于入场,8794 的"离场硬门"教训)。
- `reduce` → 按信号百分比部分平;没有百分比 → 一半。
- `stop_loss_update` → 只自动**收紧**;放松需人工批准(pending_review)。"移到保本"识别为收紧到入场价。
- `take_profit_update` → 改分档止盈。
- `cancel` → 撤未成交入场腿。
- `add` → **不自动执行**(8794 至今没有自动路,原因是仓位链不可靠);在 gated 模式下当一次新的 open 触发处理,copy 模式记 `trader_add_manual` 留人工。
- 管理动作找不到关联线程 → 记 `trader_mgmt_orphan`,不动仓。

权重:
- `weight = manual_weight × auto_mult`;`auto_mult` 由 8794 的 `win_rate` 与 `max_drawdown` 分三档
  (**口径修正 2026-09-13**:`/api/copytrading/trader-stats` 是**全量**聚合,不分窗口 —— 原文写的
  「近 90 天」与接口实际口径不符;要 90 天得改对接 `/api/leaderboard?window=90d`,列为后续)(≥0.55 且 dd ≤15% → 1.0;dd > 30% → 0.5;其余 0.75),阈值进设置可改。统计拉不到 → 用 manual_weight,前端标"统计过期"。

## 3. 存储与接口

- 迁移 `0022_trader_signal.sql`:`demo_trader_signal(id, signal_id unique, trader, symbol, side, action, entry_kind, entry_prices json, stop, tps json, size_pct, valid_until, published_at, ingested_at, raw_text, status, mode_applied, thread_id, decision json, created_at, updated_at)`;status ∈ `new|triggered|applied|skipped|evidence|review_only|expired|dead|mgmt_applied|mgmt_orphan`。
- 游标与凭证放 kv:`follow.cursor`、`follow.credentials`(返回时脱敏)。
- `workflow.follow`:`{ enabled, bridge_url, stats_url, freshness_s, default_mode, max_signals_per_trader_per_day, traders: { [name]: { mode, manual_weight, enabled } }, thresholds }`。
- HTTP:`GET/POST /api/follow`(设置、连接状态、游标、DLQ 计数)、`GET /api/follow/signals?trader=&status=&limit=`、`POST /api/follow/signals/:id/apply`(人工强制按 copy 跟)、`POST /api/follow/signals/:id/skip`、`GET /api/follow/stats`(8794 权重表 + 本地每人:触发数、跟了几单、agent 同向率、已实现 R)。SSE `trader_signal`(新信号 / 状态变化)。
- 判断账本:每条 open/add 写一行 `source='trader'`,gated 模式的 agent 判断与之同 `cluster_id`,`realized` 走现有结算。decision_record 的 reason code 枚举新增:`trader_follow_copy`、`trader_follow_agent_agree`、`trader_follow_agent_disagree`、`trader_follow_agent_flat`、`trader_signal_stale`、`trader_signal_no_stop`、`trader_gate_blocked`、`trader_reverse_exposure`、`trader_duplicate_open`、`trader_add_manual`、`trader_mgmt_orphan`。
- 归因:episode/thread 带 `origin: 'trader:<name>'`,归因报表按 origin 多一维。
- 契约:`docs/demo/v3-ui-contract.md` §9.38(前端另起包做「跟单」页:交易员卡片(模式/权重/统计)、信号流(状态、agent 结论、跟/跳按钮)、设置)。

## 4. 不做

- 不改 active、不改晋升门、不动 8794、不给 bridge 写任何东西(只读订阅 + ack 游标)。
- 不自动执行 `add`;不自动放松止损。
- 不把交易员信号喂给影子腿(对照统计仍要干净)。
- 代币化美股信号(交易员C)只在 backend 支持该 symbol 时进 copy/gated,否则 evidence。

## 5. 验收

- 本机对 bridge 真订阅:拉到三人历史 500 条补拉全部 `review_only`,不开仓;新信号 30 秒内出现在 `/api/follow/signals` 与 SSE。
- 单测:归一化(区间/阶梯/市价意图/多档 TP/无止损)、三模式分支、管理动作路由(含孤儿与放松止损需批准)、新鲜度、重复开仓与再入场、权重三档、游标与退避、DLQ。
- 全量 vitest 绿、tsc 干净;`npm run build` 出 dist;不重启 18801(由 Jacky 决定)。

## 6. 首发范围收缩(2026-09-13,二审之后)

两轮对抗复审(内部评审记录、`follow-review-r2.md`)的结论:上面 §2 那份管理动作清单
**超出了这一版能安全执行的范围**。按比例减仓要「成交归属定量 + 入场余量先收口」,改保护腿要
「只撤本线程自己持有的 order id + 逐张核终态 + 替换失败能恢复」,分档止盈要分档减仓 —— 三样都没有。
所以首发**按下面这张表收缩**:宁可少做,不做假执行。

### 自动执行的只有三类

| 动作 | 自动做什么 | 闸 |
|---|---|---|
| `open` / `add` | copy/gated 开一条线程:**单腿**限价,或市价意图翻出来的「顶着滑点上限的限价」 | 完整一遍 `evaluateGates` + `entryStyleGate` + `preflightOpen`(事件黑窗、保护凭证、线程数与每日开仓上限都在里面)+ 发送前最后一次授权重查 |
| `close` / `stopped_out` | 平掉**本线程**(平之前先把入场余量收口) | 平完要核实线程真的不在场上;回执 unknown → `review_only` |
| `cancel` | 撤**本线程自己那张**入场腿(`entry_client_order_id`) | unknown 不算已撤;部分成交余量也走同一条撤单链 |

### 一律转人工(`review_only`,不动仓、不撤单)

- `reduce`、`stop_loss_update`(**收紧也不自动**)、`take_profit_update`:硬开关
  `follow.auto_manage` 无条件 `false`,设置页不暴露、接口不接受输入,runtime 侧**没有执行器**
  (`followReduce` / `followUpdateStop` / `followUpdateTps` / `replaceProtection` 已整段删除)。
  人工队列里会写清「想减多少 / 目标止损 / 目标止盈」,由人去执行。
- **多档阶梯入场**(`entry_kind='ladder'`):线程只有一条入场腿,分不了档 → `unsupported` 转人工,
  绝不按第一档挂全量。
- **分档止盈**:开仓只挂**第一档**,线程与 API 上标 `tp_partial_unsupported`(列出没挂的档位与份额)。
  不再声称份额已兑现 —— 把三档价都写进线程会让保护腿按第一档挂**全仓** TP,经济行为是「到第一档全平」。
- 补拉(backfill)的历史管理动作、迟到超龄的管理动作、「上次已发出未确认」的动作。

### 为什么这么收

`close`/`cancel` 与 `reduce`/改保护的区别不是「难度」,是**错了以后的形状**:前两者是**减敞口**且量是
「本线程全部」,算错的空间接近零;后三者要么按比例定量(算错就多平/少平别人的仓),要么先撤后挂
(撤穿了就是一段无保护窗口)。离场纪律强于入场这条仍然成立 —— 它由 `close` 那条自动路径承担。

延后的四件事(做完才谈打开 `auto_manage`):多腿入场的线程模型(入场腿数组 + 逐腿 CID/成交/撤单/对账)、
保护腿的可对账替换(归属证明 + 替换阶段持久化 + 失败恢复)、分档减仓、以及这些路径的离线故障注入。

## 7. 首发再收一档:零自动交易所写(2026-09-13,三审之后拍板)

三审(内部评审记录)指出:§6 收缩之后,**自动路径仍然会写交易所** ——
`close` 走到 `closeThreadNow` 的 `cancelAll(symbol)` + `closePosition(symbol)`(按币,不是按本线程认领量);
实际开仓与保护巡检没进同一条账户串行;「最后一次授权检查」后面还有几次 I/O;信号几何没过持仓经济闸。
所以 Jacky 拍板:**跟单 session 首发不做任何自动的交易所写操作**。

### 代码常量,不是设置项

`FOLLOW_AUTO_EXECUTION = false`(`trader-follow.ts`)。它不进 `workflow.follow`、不进 API 的可写字段 ——
因为它不是「功能开关」,是「这套东西还没拿到自动动钱的资格」。`GET /api/follow` 的 `scope.auto_execution`
只读地报出来给前端画说明。

| 信号 | 首发行为 |
|---|---|
| `open` / `add`(copy 模式) | 落 `review_only`,可执行几何写进 `decision.plan` |
| `open` / `add`(gated 模式) | **照跑 agent 判断**(那是它的价值),结论落 `decision.agent`;同向 → `review_only`;反向/不入场/被闸拒 → `skipped`(结论同样落行,人能看到为什么不跟) |
| `open` / `add`(evidence 模式) | `evidence`,不问 agent |
| `close` / `stopped_out` / `cancel` | 落 `review_only`,关联线程记在 `thread_id` 上 |
| `reduce` / `stop_loss_update` / `take_profit_update` | 落 `review_only`(§6 已定) |
| 入场腿过了信号 `valid_until` | 只打 `ENTRY_EXPIRED` 告警,**不自动撤单** |

### 零写承诺的**范围**(四审之后收紧措辞)

「零自动交易所写」指的是 **跟单链路自身**:feed 拉取 → `capture` 落库 → `resolveMode` 判定 →
`ingest` 处置 → `resume` 恢复 → 信号级巡检(入场腿过期那一处)。这整条链路**不发起任何交易所写调用**。

它**不包括**人工 apply 之后那条线程的既有生命周期。这是一次明确的口径选择:

> **人工 apply 开出的线程 = 普通手动线程,交给既有系统管理。**
> 成交后补保护腿、到点复查、线程结束时 `cancelAll(symbol)` —— 这些都是 runtime 对**所有**线程
> (手动开的、agent 开的)一直在做的既有行为,**不是跟单新增的承诺**,也不由跟单代码触发。
> 旧版本遗留的 `origin:'trader:*'` 线程同样按普通线程处理:它们和别的线程走同一套巡检与复查。

换句话说:跟单负责「把信号变成一条可执行的建议」,人按下 apply 之后,**这条线程就交接给既有系统了**,
和人在交易页手动开的仓没有区别。四审 R4-01 指出的那些自动写(补保护、自动复查、结束时撤单)
都落在交接之后那一侧。

### 人做的事走既有人工链路

- `POST /api/follow/signals/:id/apply` —— 用**行上那份几何**(`decision.plan`,不重算)走
  **既有手动开仓链路**(`source:'manual'`):止损校验、名义上限、`preflightOpen`、`entry_style`、
  事件黑窗、每日开仓上限全在那条链里。线程带 `origin:'trader:<name>'` 与 `trader_signal_id`,
  归因仍能按 origin 分。**原子领取**:条件更新 `review_only → applying`,抢不到就是 409。
  发送前再核一次授权(名册/启用/模式/权重/期限),`force_stale` **只豁免年龄**、不短路授权。
- `POST /api/follow/signals/:id/skip` —— 只改状态,**只接受 `review_only`**。
- **没有 close 端点**:平仓去交易页(线程页)做。跟单不提供「按信号平仓」的入口 ——
  `closeThreadNow` 是按币撤单+按币平仓的,证明不了「只动本线程」(四审 R4-02)。

`review_only` 因此是**唯一的「可执行前态」**:前端只在这一档给「跟 / 跳」两个按钮。

### 信号行的状态机(四审 R4-03)

```
new ──处置──▶ review_only ──apply(原子领取)──▶ applying ──┬──▶ applied
                   │                                      ├──▶ apply_failed(可再试)
                   └──skip──▶ skipped                      └──崩溃──▶ resume 隔离回 review_only
                                                                      + needs_reconcile(人去对账)
```

- `triggered`/`applying` **不许被 skip 抹掉**:那会擦掉「已经发出过」这个事实,崩溃后 resume 就不隔离它了。
- `applying` 行崩溃后**永远不自动重发** —— 隔离成 `review_only + needs_reconcile`,由人核对交易所。

### 兜底测试

自动路径的代码留在常量后面(改回来是一行),所以光看状态机不够。测试直接数
**跟单链路自身**对 backend 写方法的调用次数(范围见上一节;人点 apply 之后的线程生命周期不在其内):
`placeEntry` / `openWithProtection` / `placeStop` / `placeTakeProfit` / `closePosition` / `reducePosition` /
`cancelAll` / `cancelOrder` / `cancelAlgoOrder` / `setLeverage` / `setMarginType`。
三种模式 × 八种动作 × 补拉/实时/重投/崩溃恢复/到期巡检,调用次数必须是 **0**;
另有一条反向用例(人点 apply/close 之后确实出现写调用)证明计数器有效。

### 开启自动执行之前必修(三审 R3-01/02/03/05)

这四条**不算已修**,它们是「打开 `FOLLOW_AUTO_EXECUTION` 的前置条件」:

1. **R3-01**:`close` 的整币范围 —— 撤单只用已证明归属的 CID,平仓用经对账的本线程剩余量 + reduce-only,
   归属不明转人工。(`closeThreadNow` 是手动平仓/常规 EXIT 共用的既有函数,改它要动既有动钱链路。)
2. **R3-02**:可组合的账户串行边界,覆盖**实际开仓**与保护/撤单巡检,且持锁任务不得再等回同一条队列。
3. **R3-03**:授权/期限/当前风险上限的重核要落在**真正发送那一刻**(`executeOpen` 里 leverage/margin/account
   几次 I/O 之后),只拒不改冻结的经济字段。
4. **R3-05**:信号最终几何要建持仓计划并过 `holdingEntryGates`(ATR 尺度、扣成本净 RR、结构失效价),
   缺数据就拒;第一档全仓 TP 之后净 RR 要按第一档重算。

### bridge 订阅钥匙的边界(待 Jacky 确认)

AGENTS.md 第 1 条「凭证只进 execd、TS 进程不得出现 API key/secret」——本轮按
**「它针对的是交易所凭证(OAuth token / 交易所 API key / PKCE verifier / 直连交易所)」** 来理解;
bridge 的订阅钥匙是第三方**只读**订阅凭据,不能下单、不能动钱、拿到也只能读到信号流,
因此本轮**保留 env 读法**(`TG_FOLLOW_BRIDGE_KEY` / `TG_FOLLOW_BRIDGE_SECRET`),没有改 AGENTS.md。

**这条理解待 Jacky 确认**。若确认为「所有外部凭据都必须进 execd」,则要把这条 HTTP 请求整段搬到 execd
(或另立一个凭证边界),并轮换现有 bridge key。三审对此判「仍违反硬规则」,分歧点就在这条理解上。
