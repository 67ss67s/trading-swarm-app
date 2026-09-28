# OKX.AI ASP 订阅信号 + Agentic Wallet 接入方案(待拍板)

日期:2026-09-20。前置:`docs/design/okx-atk-2026-09-20.md`(ATK 执行通道)。
本文是**方案与问题清单**,按 Jacky 的要求:动手前先商量。

## 1. 对象是什么(读完 onchainos / okx-ai 技能与 CLI 之后的结论)

OnchainOS 这一侧有三样东西和我们相关:

1. **OKX.AI 代理市场(ERC-8004 身份)**。三种角色:User(买家)、ASP(服务商)、Evaluator。
   ASP 用 `onchainos agent create --role asp` 注册,服务分两类:
   - `A2A`:代理对代理服务,可按次或**按月订阅**(可带 3 天试用);典型就是「交易信号订阅」。
   - `A2MCP`:一个公开 HTTPS 端点,按次收费(x402 支付)。
2. **订阅信号投递链路**。买家 `create-subscribe` 订阅后,ASP 侧对每期用
   `onchainos agent deliver <jobId> --deliverable-text "<信号>" --agent-id <asp>` 投递;
   买家的 agent 通过 `okx-a2a` 守护进程(XMTP)收到 `active_subscription_signal`,由**买家自己的 agent**
   决定是否按信号在 Trade Kit 下单(需要买家事先持久化 `consentSnapshot`:环境 live/demo、保证金模式、
   下单策略 market/signal_price_limit;每次投递都过 `trade-kit-readiness` 门;每个 deliveryId 最多执行一次)。
   平台明确把「信号」当不可信数据,自动执行只允许 `place` / `close_position` 两种操作。
3. **Agentic Wallet**(TEE 托管私钥,社交登录)。`onchainos wallet login/balance/send/contract-call`,
   加上 DEX swap、DeFi、payments(x402 / 支付链接)。它是链上的钱包,**和 OKX 交易所账户(ATK 用的 API key)
   不是一个东西**;订阅费用(USDT)从这个钱包扣。

## 2. 三种接法,建议做 A + B

### A. trade-gate 作为**买家侧**:把 ASP 订阅信号接进现有「跟单」页(推荐,先做)

现在的跟单 session 已经有「外部交易员信号 → agent 判断依据 → 人工 apply/skip/reconcile,零自动交易所写」
这条完整流水线(bridge 触发)。ASP 订阅信号在语义上就是另一种交易员信号源:

- 新增信号源 `okx_asp`:网关起一个 `okx-a2a` 守护(或轮询 `onchainos agent my-subscriptions --role buyer` +
  `task-deliverable-list`),每条 deliverable 解析成 `TraderSignal`(交易员 = ASP 名字,原文当不可信文本进 `raw`),
  走现有 `judgeTraderSignal` → 跟单页人工 apply。**不做平台的 autotrade 链路**(那条要走 OKX 自己的
  consentSnapshot + trade-kit-readiness,和我们的闸门体系是两套;我们保留自己的人工审批和风控)。
- 前端「跟单」页加「订阅源」分栏:已订阅的 ASP 服务列表(`my-subscriptions`)、每个服务最近 N 条信号、
  跟/跳过的战绩(复用现有 stats)。
- 「接服务」的用户体验:设置页 → 「OKX 账户」卡片 → 三个状态灯:钱包(`onchainos wallet status`)、
  A2A 守护(`okx-a2a status`)、Trade Kit(`okx config` profile)。没登录就给按钮,点了弹 Terminal 跑
  `onchainos wallet login`(浏览器社交登录,和现在 `claude /mcp` 弹终端登录同款路数)。
- 订阅动作本身(挑 ASP、付费、试用)先**不**在我们前端做,留给 OKX 的 agent 对话(`okx-ai` 技能),
  我们只读结果;理由:订阅涉及 EIP-712 签名和付费确认,平台要求走它的确认卡片,复刻一遍风险高。
  第二阶段可以在前端嵌一个「搜索信号服务」(`agent search` / `service-match`)+ 一键把订阅命令复制到终端。

### B. trade-gate 作为**ASP**:把我们的策略/信号发成一个 A2A 月订阅服务(适合参赛,第二步做)

- 注册一个 ASP 身份(需要:品牌名、描述、头像图片、服务名、类型 A2A、定价 `2` 月订阅或 `3` 带试用)。
  注册是对话式流程(consent、QA、确认卡),**用 `okx-ai` 技能在 Claude 里跑一次**即可,不需要写代码。
- 网关加「发布器」:线程开仓/加减仓/平仓事件(或策略 Lab 的 paper+ 晋升信号)→ 渲染成固定格式的信号文本
  (方向/币/入场/止损/止盈/有效期,中英双语)→ 对每个活跃订阅 `onchainos agent deliver --deliverable-text`。
  投递有幂等表(thread event id → jobId → 已投递),失败不自动重发(和资金动作同一纪律)。
- 参赛叙事:「一个 agent 团队既消费别人的信号也生产自己的信号,全程在 OKX 生态内闭环」。
- 需要注意平台规则:`deliver` 只在 `job_accepted` 后允许;续期后要 `subscribe-asp-claim` 领款;
  买家拒收要在 ~1 天内回应(争议/同意退款)。这些事件由 `okx-a2a` 守护推给 agent 会话,
  我们要么在网关里接住(写状态机),要么只做「投递」,把售后留给 Claude 会话处理(建议先这样)。

### C. Agentic Wallet 深接(不建议本轮做)

除了作为 A/B 的登录与付费前提之外,把钱包余额/链上持仓画到前端、DEX swap、DeFi 收益都属于另一个产品面
(现货/链上),和永续交易台的核心不相干。本轮只做:钱包登录状态灯 + 余额一行(付订阅费够不够)。

## 3. 需要 Jacky 拍板的问题

1. **先做 A 还是 B?** 我的建议顺序 A → B(A 复用跟单页,一两天;B 要先在 OKX 注册 ASP 身份,需要你出
   品牌名/头像/定价,并且投递内容要你认可格式)。
2. **A 的信号源用守护还是轮询?** `okx-a2a` 守护是官方路径(实时,但要常驻进程 + 钱包登录态);
   轮询 `task-deliverable-list` 简单但延迟分钟级,且不确定是否对订阅型任务开放。我先做轮询验证接口,能通就
   两者都留,默认守护。
3. **B 发什么?** 候选:(i) 线程真实开平仓(有真实盈亏、可信),(ii) 策略 Lab 的 paper+ 策略信号(量大但纸面),
   (iii) 跟单页人工 apply 过的外部信号二次转发(有版权/合规问题,不建议)。我建议 (i)。
4. **定价/试用**:月订阅 + 3 天试用(选项 3)最利于参赛演示;金额你定(0 也允许,免费服务)。
5. **钱包**:用哪个社交账号登 Agentic Wallet、订阅费从哪里来,需要你本人在浏览器完成;我只能把入口做出来。
6. **合规**:ASP 描述不能有链接、不能有名人名、名称 CN 2–12 / EN 3–25;信号文本要避免「保证收益」类措辞
   (`sensitive-words` 会拦)。文案我出初稿给你过目。

## 3b. 本机现状(只读探测,2026-09-20)

- Agentic Wallet 已登录(Google,Account 1),`okx-a2a` 守护在跑,User 身份 Agent #13529「Jacky」在,
  当前**没有活跃订阅**(09-12 试过 ASP #8136 / service 36563 的 3 天试用,见 <local tool>)。
- 那次的经验直接回答了问题 2:投递落在 `~/.okx-agent-task/sqlite/session-store.sqlite` 的
  `pending_gateway_deliveries`,是**消费即删的队列**,不是台账;okx-signal-lab 的 collect.py 就是靠轮询它归档的。
  所以方案 A 的信号源可以直接复用这条路(读队列 → 落我们自己的表),不必先啃 XMTP 守护的 agent 会话协议。
- 也提醒 B:市场上买家看不到 ASP 历史业绩,评价评的是交付合规;我们发信号时把线程的真实结算盈亏一并带上,
  反而是差异点。

## 4. 我在等你答复前能先做的(不越界)

- 验证 `onchainos`/`okx-a2a` 在本机的登录与 `my-subscriptions` 只读调用是否可用(不订阅、不付费)。
- 在网关里加 `TraderSignal.source = 'okx_asp'` 的类型位与解析器骨架 + 单测(纯代码,不连外部)。
- 前端设置页的「OKX 账户」三状态灯(只读探测)。
