# 信号市场(Signal Market · OKX.AI ASP)— 页面重做 + ASP Agent 设计稿

日期 2026-09-20。仓库 `~/Desktop/trading-swarm-okx`(分支 okx-devday,dev 18811/5191)。
前置:`okx-atk-2026-09-20.md`(ATK 执行通道)、`okx-asp-follow-2026-09-20.md`(方案 A,已落地 e5aa709)、
`okx-asp-wallet-proposal-2026-09-20.md`(A→B 拍板)。本文**取代**方案 A 的前端部分,并把「跟单」页整页重做。

Jacky 的要求(原话要点):跟单页去掉 8794 / bridge 的所有痕迹,改成完整的 ASP 适配;参考 okx.ai/tutorial、
dev-docs、okx.ai/agents;信号 relay 参考 bridge console;用户可以订 ASP 信号自动交易,也可以让 agent 按研究好的
策略跑,做判断时 relay 一份到 ASP 卖订阅;再加一个专管 ASP 的 agent 和对应 skill。后端 外部评审写,
前端主线写。

## 0. 结论先行

1. **页面改名「信号市场」(EN: Signal Market),页 id `market`,路由 `#/market`,副标题 `OKX.AI · ASP`。**
   不叫「ASP Marketplace」:ASP 是 OKX 的内部行话,侧栏一个词要让人看懂是「买信号 / 卖信号」的地方;
   OKX 品牌放副标题和页头,参赛叙事不丢。「跟单」这一页从侧栏消失,`follow` 页 id 与路由删掉。
2. **一页四栏:市场 / 订阅 / 信号 / 发布。** 买(市场+订阅)、收(信号,复用现有 apply/skip/reconcile 流水线)、
   卖(发布:ASP 身份、服务、订阅者、投递账本、收入领取、售后待办)。顶部一条 OKX 账户条。
3. **8794 与 bridge 在这一页零痕迹**:没有权重表、没有交易员名册、没有 bridge 凭证。跟单流水线本身
   (`trader-follow.ts` 的 ingest → 判定 → 人工 apply)保留,它已经是信号源无关的;fork 里 **bridge feed 不再接线**,
   `FollowSettings` 里 `bridge_url/stats_url/traders/thresholds` 换成按订阅配置(§2.2)。
4. **入站 relay 照抄 bridge console 的骨架**:采集器 → **落自己的耐久账本**(`okx_market_delivery_in`,
   按 deliveryId 幂等)→ 游标消费 → 归一化 → 跟单流水线 → DLQ。okx-a2a 的队列是消费即删的,所以账本必须是我们的。
5. **出站 relay 只发我们自己产生的两类东西**:线程真实开/平/减仓 → `signal_type: order`;agent 的判断
   (有方向但没开仓,或开仓前的判断本身)→ `signal_type: analysis`。**买来的 ASP 信号永远不转发。**
   格式对齐市场里已经在卖的 #8136 那套 JSON(§3.3),这样任何 OKX 买家 agent 走官方 autotrade 都能吃。
6. **新增第九个角色 `asp_agent`**(团队卡、bot_runs、handoff 全套接上),它是**代码为主、模型极少**的角色:
   relay/扇出/领款/去重是代码;模型只用在三处 —— 写服务上架文案、把判断改写成 analysis 的人话摘要、
   给售后拒收起草回复。skill 放仓库 `skills/asp-agent/SKILL.md`(§5),host agent(Claude/Codex 会话)照它操作。
7. **不做**:不用 OKX 的 autotrade consent 链路(我们自己的闸门体系管执行)、不做 Evaluator、不做 A2MCP 端点
   (x402 按次付费,下一轮)、不碰 Agentic Wallet 除登录态与订阅费余额一行。

## 1. 把 OKX.AI 这一侧摸清(2026-09-20 实测 + 技能文档)

| 事实 | 出处 | 对设计的影响 |
|---|---|---|
| 市场发现**只有 CLI**,没有公开 HTTP API:`onchainos agent service-match --keywords … --search-after …`,返回 `services[]`(asp.{aspAgentId,aspName,rating,feedbackRate,soldCount,onlineStatus}、serviceId/sid、serviceName/Description、serviceType A2A/A2MCP、feeAmount/feeTokenSymbol、subscription[]、freeTrial、supportTrial、isSubscribing) | 本机实测 | 网关包一层 CLI 当作我们的 marketplace API;okx.ai/agents 页面就是这个数据的网页版,卡片字段照它画 |
| 详情:`agent profile <id>`、`service-list --agent-id`、`feedback-list --agent-id`(评分已换算 0–5) | 技能 identity-discover / reputation | 详情抽屉三段:资料 / 服务 / 评价 |
| 订阅:`create-subscribe --service-id --service-token-amount --service-token-address --auto-renew 0/1 --use-trial --title --description [--provider-agent-id]`,CLI 内部完成 EIP-712 签名与广播;成功后 deviceList=null(所有设备都收) | 技能 task-cli-reference | 订阅可以在我们前端发起,网关跑 CLI;确认弹窗我们自己画;**不传任何 `--autotrade-*`** |
| 取消/拒收/续费:`subscribe-cancel`、`subscribe-reject`、`start-autorenew`、`subscribe-detail`、`subscribe-cost`;`jobId` 是唯一主键 | 同上 | 订阅卡上的按钮一一对应 |
| 设备:每次钱包登录是一个 device;`subscribe-device-update --job-id --device-list` 整体覆盖;`my-subscriptions` 返回 `thisDeviceId/thisDeviceReceives` | 同上 | 网关所在机器必须在接收集合里,否则收不到;订阅成功后自动确保本机在集合里 |
| 投递落地:XMTP → 本机 `okx-a2a` 守护 → `~/.okx-agent-task/sqlite/session-store.sqlite` 表 `pending_gateway_deliveries`(**消费即删**);官方读法是 `okx-a2a user watch --json`(长轮询、破坏性读、先吐积压再等新) | okx-signal-lab 实证 + watch-core | 采集器两种 transport(§2.1),账本必须自己落 |
| 卖方无「接单」动作:买家订阅 → 系统事件 `sub_asp_selected` 推给 ASP,平台自动 apply;之后 ASP 用 `subscribe-active --agent-id` 拿活跃 jobId 列表,对**每个 jobId** `deliver <jobId> --deliverable-text … --agent-id <asp>`(逐户投递,没有广播) | task-asp-accept / task-cli-reference | 发布器 = 扇出循环 + 幂等表(§3) |
| 售后事件:`sub_renew` → ASP 跑 `subscribe-asp-claim` 领上期收入;`sub_user_reject` → 约 1 天内二选一 `subscribe-agree-refund` / `subscribe-dispute`,过期自动退款;`asp-claimable` / `asp-claim-rewards` 随时可查可领 | 同上 | 领款代码自动;拒收进人工待办 |
| 注册 ASP:`pre-check --role asp` → 字段(名 CN 2–12/EN 3–25、描述 ≤500、**头像必传文件**、服务名 5–30、A2A 定价三选一:按次 / 月订阅 / 月订阅+72h 试用,fee 为字符串数字 USDT)→ `validate-listing` → `create` → `activate`;一钱包一 ASP;费用 OKX 出 | identity-register | 注册表单可以在我们前端做,QA 结果原样展示;敏感词(保证收益等)会被拦 |
| 本机现状:钱包已登录,`okx-a2a` 守护在跑(pid 54129),User 身份 #13529「Jacky」,**没有 ASP 身份,没有活跃订阅** | 实测 | 演示要先注册一个 ASP + 订一个服务 |
| 评价评的是交付合规不是盈亏;市场上买家看不到 ASP 历史业绩 | 09-12 调研 | 我们的差异点:投递里带线程真实结算 R,发布栏公开自己的 track record |

## 2. 买方侧(市场 / 订阅 / 信号)

### 2.1 入站 relay(参考 bridge console)

bridge console 的骨架是:订阅者带游标长轮询 → 服务端只读 → 客户端本地落库 → 幂等 → DLQ → 状态页。这里一样,只是「服务端」换成本机 okx-a2a。

```
okx-a2a 守护(XMTP) ──┬─ transport=queue : 只读轮询 pending_gateway_deliveries(现有 okx-asp-feed,3s)
                      └─ transport=watch : 子进程 `okx-a2a user watch --json` 常驻,逐行读 stdout(待验证 §7-1)
        │  QueueRow / WatchItem
        ▼
  okx_market_delivery_in(耐久账本,主键 delivery_id;raw 全文、job_id、received_at、parse_status、signal_id)
        │  游标 = kv market.in_cursor(按 rowid)
        ▼
  normalizeAspSignal(现有)→ TraderSignal{transport:'okx_asp', trader:<ASP 名>, subscription_job_id}
        │
        ▼
  TraderFollow.ingest → 按订阅的 mode(copy / gated / evidence)→ 现有 apply/skip/reconcile + review_only 队列
        │
        └─ 坏行 / analysis 类 → 账本上标 parse_status,不进流;前端「信号」栏可看「已忽略 N 条」
```

- 两种 transport 都通过同一个 `MarketInbox` 接口喂账本;默认 `queue`(已验证),`watch` 做出来验证后再切默认。
  **两者不能同时开**(watch 是破坏性读,会把队列吃空)。
- 账本是**追加不改**的;归一化失败不影响落账;同一 deliveryId 重复到达只计数。这解决现在 kv `okx_asp.seen` 那套上限 5000 的临时做法。
- `subscription_job_id` 从投递行的 `job_id` 来;查不到就落 `unknown`,前端归到「未知来源」而不是丢。

### 2.2 订阅级配置(取代交易员名册)

`FollowSettings` 改为:

```ts
interface MarketSettings {
  enabled: boolean;                 // 总开关(收信号)
  transport: 'queue' | 'watch';
  poll_ms: number;                  // queue 用
  freshness_s: number;              // 同现有
  default_mode: 'copy' | 'gated' | 'evidence';
  subscriptions: Record<string /*jobId*/, {
    mode: 'copy' | 'gated' | 'evidence';
    weight: number;                 // 0–1,乘 risk_pct;没有 8794 了,纯人工
    enabled: boolean;               // 只影响是否进流,不影响 OKX 侧订阅状态
    label?: string;                 // 本地备注
  }>;
}
```

- `copy` = 「订阅信号自动交易」。**仍然过 trading-swarm 自己的全部闸**(preflight、名义上限、每日开仓上限、止损必需、
  新鲜度、反向敞口、重复开仓),仍然零 OKX autotrade consent。首发 `copy` 只对 `open` 生效,管理动作按现行 §6 收缩规则进 review_only。
- `gated` = agent 把关(现有 scan episode 路径,trigger `trader_signal`)。
- `evidence` = 只进判断账本。
- 权重没有外部统计源了,用本地战绩:每个订阅算「跟了几单 / 已实现 R / agent 同向率」,前端显示,不自动改权重。

### 2.3 市场栏(Browse)

- 搜索框(关键词,默认 `信号 signal 合约 perp`)+ 筛选:只看 A2A 订阅制 / 有试用 / 价格上限;分页用 `searchAfter`。
- 服务卡(照 okx.ai/agents 的信息密度):ASP 名 + 在线点、评分 ★ + 好评率 + 已售、服务名、类型徽标、价格(`20 USDT/月` 或 `1 USDT/次`)、试用徽标、描述前 160 字、`isSubscribing` 时显示「已订阅」。
- 动作:「详情」抽屉(profile + service-list + feedback-list,评价原文当不可信文本渲染)、「试用」/「订阅」→ 确认弹窗:
  标题/描述自动填(`trading-swarm 订阅 · <服务名>`)、自动续费开关(默认关)、本地模式(默认 `evidence`,想 copy 要手动选并看到闸门说明)、权重、费用与钱包余额一行、
  「本机将成为接收设备」提示 → 确认 → 网关 `create-subscribe`(不带 autotrade)→ 成功后 `subscribe-device-update` 确保本机在接收集合 → 写本地订阅配置 → 跳订阅栏。
- 余额不够:CLI 会回 `fundingNoticeCommand`,前端展示充值地址与二维码(网关跑 `funding-notice`)。

### 2.4 订阅栏(My subscriptions)

- 数据 = `my-subscriptions --role buyer` ∪ 本地配置 ∪ 本地战绩。
- 每张订阅卡:服务名 / ASP / 状态(ACTIVE、试用中、已拒收、已完成…)/ 当前期 `periodIndex` 与到期时间 / 自动续费 / 本机是否接收(可切)/
  模式切换(copy/gated/evidence)/ 权重 / 启用 / 本地统计(收到 N、order N、analysis N、跟了 N、已实现 R)/ 最近一条信号时间。
- 动作:取消(试用取消 = 终止;付费 = 关自动续费)、拒收本期(填理由,进 OKX 争议流程)、开自动续费(EIP-712 签名,CLI 内部完成)、详情。
- 顶部:`subscribe-cost` 的月成本合计 + 钱包 USDT 余额。

### 2.5 信号栏(Inbox)

- 复用现有 `SignalRow` / 待办 / 确认弹窗组件,去掉 transport 徽标逻辑(全是 OKX.AI),按订阅筛选,状态筛选。
- 加一个「原文」展开:账本里的 raw 全文(≤4000 字)+ 解析结果 + 为什么没进流(analysis / 坏行 / 过期)。
- 待办(review_only / pending_review)与现在一致:apply / skip / reconcile。
- SSE:`market_delivery`(新投递落账本)、`trader_signal`(现有,状态变化)。

### 2.6 Agentic Wallet 在这一页的位置(2026-09-20 Jacky 补充)

ASP 订阅整条链路是**靠 Agentic Wallet 跑起来的**:买家身份(User #13529)和卖家身份(ASP)都是这个钱包名下的 ERC-8004 身份;
`create-subscribe` 的 EIP-712 签名与订阅费(XLayer 上的 USDT)都从它出;卖方 `subscribe-asp-claim` / `asp-claim-rewards` 领到的收入也进它。
所以顶部状态条里钱包不是一盏灯,而是一张**钱包卡**:

- 登录态(社交账号邮箱 / Account 名)、钱包地址(缩写 + 复制)、链 XLayer;
- USDT 余额一行 + 月订阅成本合计(`subscribe-cost`)+「够付 N 个月」的粗算;
- 「充值」按钮:显示 XLayer USDT 充值地址与二维码(网关跑 `funding-notice` 渲染,或直接给地址);
- 没登录 → 「登录钱包」按钮(复用账户菜单的 `onchainos wallet login` 弹终端路数);
- 发布栏的「可领收入」旁边写明「领到 Agentic Wallet」,领取后余额行刷新。

后端补两项:`GET /api/market/status` 返回 `wallet: { logged_in, email, account_name, address, chain:'xlayer', balance_usdt, deposit_address }`
(余额与地址走 `onchainos wallet status` / `wallet balance`,缓存 30s);`POST /api/market/wallet/deposit-notice` 返回充值地址 + 二维码 PNG(base64)。
钱包的其它能力(DEX swap、DeFi、转账)仍然不进这一页。

## 3. 卖方侧(发布栏)+ 出站 relay

### 3.1 ASP 身份与服务

- 没有 ASP 身份时:发布栏是一张注册表单(名称、描述、头像文件上传、服务名、定价三选一、服务描述三段式),
  「校验」按钮跑 `validate-listing` 把 findings 逐条列出(block 必须清),「注册」→ 网关 `pre-check` + `upload` + `create`(确认弹窗,写明「链上身份,OKX 付 gas」)→ 成功显示 `#id` →「上架」按钮 `activate`。
- 有身份时:身份卡(#id、名、状态、审核状态、评分、已售)、服务列表(`service-list`)、编辑 → `update`。
- 文案初稿由模型写(asp_agent 的模型调用点之一),但**发布前人看一遍**;敏感词校验交给 `validate-listing`。

### 3.2 订阅者与收入

- `subscribe-active --agent-id` = 当前扇出集合;`my-subscriptions --role provider` = 全量含历史;两者合成订阅者表(买家 #id、当前期、到期、状态)。
- `asp-claimable` 显示可领收入;「领取」按钮 → `asp-claim-rewards`;`sub_renew` 事件到达时代码自动 `subscribe-asp-claim`(领钱是安全动作,自动)。
- 售后待办:`sub_user_reject` 进「待处理」列表,显示买家理由、期次、剩余时限;两个按钮「同意退款」/「争议」(争议要填理由,模型可起草,人点)。

### 3.3 发布器(出站 relay)

事件源(全部是我们自己产生的):

| 事件 | signal_type | 触发点 |
|---|---|---|
| 线程入场成交 `entry_filled` | `order` / action `LONG|SHORT` | runtime 现有 activity `entry_filled` 处 |
| 线程平仓 `thread_closed` / `sl_hit` / `tp_hit` | `order` / action `CLOSE`,附 realized R 与原因 | 同上 |
| 线程减仓(人工减仓成交) | `order` / action `REDUCE` + 百分比 | runtime 减仓路径 |
| agent 判断:scan episode 给出方向但被闸拒 / 或 stance 明确但没开 | `analysis` / action `LONG|SHORT|FLAT` | `decision_record` 落地处 |
| agent 判断:开仓前的判断本身(与上面 order 同 episode) | 不单独发,合并进 order 的 `reason` | — |
| 跟单页人工 apply 的**外部**信号 | **不发** | 版权与合规 |

发布器规则:
- 设置 `publisher: { enabled:false, publish_orders:true, publish_analysis:true, symbols:[]|['BTCUSDT',…], min_confidence?, include_realized_pnl:true, backend_filter:['okx','binance','paper'] }`。默认关;paper 线程默认**不发**(纸面单当 order 卖是欺诈,只能作为 analysis 且标注 `paper:true`)。
- 每个事件生成一条 `okx_market_delivery_out` 主记录(event_id 幂等,内容冻结),再对 `subscribe-active` 的每个 jobId 生成子行 `(event_id, job_id)` 状态 `pending → delivered | failed`;顺序投递,单条超时 20s,失败不自动重试(和资金动作同一纪律),前端「重发」按钮逐条重试;新订阅者不补发历史。
- 投递内容 = 一段人话 + 一个 JSON(与 #8136 同构,买家 agent 的官方 autotrade 解析器认这套):

```json
{"deliveryId":"tg_<event_id>","signal_type":"order","signalTime":1789890000000,
 "symbol":"BTC-USDT-SWAP","action":"LONG","price":"64120","stop_loss":"63400","take_profit":["65200","66100"],
 "leverage":null,"sz":null,"valid_until":1789890180000,"is_executable":true,
 "reason":"<agent 一句话依据>","source":"trading-swarm","thread_id":"…","realized_r":null,"backend":"okx","paper":false}
```
  平仓:`action:"CLOSE"`,带 `realized_r`、`exit_reason`;analysis:`is_executable:false`,`can_enter:false`。
  文本部分中英双语一行,不许出现「保证 / 稳赚」类词(发布前过一个本地敏感词表,`validate-listing` 的那份词表抄过来)。
- `valid_until` 默认 signalTime + 180s(市场惯例,评价里抱怨过更短的)。

### 3.4 发布栏 UI

- 身份卡 + 服务卡(§3.1)| 订阅者表 + 收入(§3.2)| 发布器设置(开关、发什么、哪些币、是否含纸面)| 投递账本(事件 → n 户成功 / m 户失败,展开看每户,重发)| 售后待办 | 公开战绩(近 30 天 order 信号数、胜率、已实现 R 合计 —— 这是给 Jacky 看的镜像,也是写进服务描述的素材)。
- 一键「投递一条测试信号」:只在**没有活跃订阅者**时可用,把渲染结果显示出来但不真发;有订阅者时按钮禁用(不能拿真买家试)。

## 4. ASP Agent(第九个角色)

- `BotRole` 加 `asp_agent`,团队卡出现「ASP Agent」头像,presence 按代码推导(采集器活着 / 发布器开着 / 有待办)。
- 职责边界:**所有 OKX.AI 相关动作只经它**。入站采集与归一化、出站扇出与账本、领款、售后待办、身份与服务管理的 CLI 调用全部收口在 `packages/gateway/src/demo/asp-agent/`(`inbox.ts` 采集、`publisher.ts` 扇出、`identity.ts` 身份/服务、`aftersales.ts` 事件与待办、`cli.ts` 统一 runner:二进制查找 `~/.local/bin` → PATH、环境原样继承(代理变量别动)、20s 超时、stdout JSON 解析、错误码映射)。现有 `okx-asp-feed.ts` 拆进 `inbox.ts`。
- 模型调用点(便宜大脑,每天上限 5 次,走现有 model-budget):① 写/改服务上架文案;② 把 `decision_record` + 证据改写成 analysis 的一句话;③ 起草拒收回复。其它全是代码,零模型。
- bot_runs 留痕:`asp_inbox_tick`(只在有新投递时落)、`asp_publish`(每事件一条,input_json 冻结事件与订阅者集合,result_json 每户结果)、`asp_claim`、`asp_aftersale`。
- handoff:`sub_user_reject` → captain 收件箱;投递失败率 > 50% → captain;系统事件 `sub_asp_selected` → 活动流「新订阅者」。
- 系统事件怎么到它手上:okx-a2a 守护把 ASP 身份的事件也落同一个队列(按 `toXmtpAddress` 匹配身份),采集器识别 `message.source==='system'` 的信封,按 `event` 分发到 aftersales;不是信号的行**不进**信号账本。

## 5. Skill:`skills/asp-agent/SKILL.md`

给 host agent(Claude Code / Codex 会话,或 agent_mcp 那条通道)用的操作手册,和 `skills/trading-swarm/SKILL.md` 同款风格:HTTP 优先、CLI 兜底。内容骨架:

1. 角色定义与红线:只经网关 `/api/market/*` 操作;不直接跑 `onchainos agent deliver`/`create-subscribe`(网关有幂等与账本);永不转发买来的信号;永不写「保证收益」;不传 `--autotrade-*`。
2. 读状态:`GET /api/market/status`、`/subscriptions`、`/inbox`、`/asp`、`/asp/deliveries`。
3. 买:搜索 → 详情 → 订阅(带 mode/weight)→ 切设备 → 取消/拒收。
4. 卖:注册表单字段与校验规则(名长、描述、头像、定价三选一、A2A 三段式描述)→ 校验 → 注册 → 上架 → 发布器开关 → 领款 → 售后二选一。
5. 投递 JSON schema(§3.3)与文本模板(中英)。
6. 故障手册:守护没跑(`okx-a2a daemon start` 后必须补代理,见 okx-signal-lab/fix-daemon-proxy.sh)、钱包未登录、本机不在接收集合、CLI 超时、`fundingNoticeCommand`。
7. OKX 官方 `okx-ai` 技能与本 skill 的分工:平台原生对话流程(评审、争议投票、A2A 聊天)留给官方技能;交易信号买卖走本 skill。

## 6. 后端接口契约(给 外部评审;同步抄进 `docs/demo/v3-ui-contract.md` §9.39)

命名空间 `/api/market/*`;现有 `/api/follow/signals*`、`/api/follow/stats` 保留供信号栏用,`/api/follow`(设置)改为返回 `MarketSettings`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/market/status` | 三盏灯(wallet/a2a/trade_kit,复用)+ **钱包卡**(§2.6 `wallet` 对象)+ 买家身份 + ASP 身份 + `subscribe-cost` + 采集器状态(transport、last_poll、账本计数、DLQ) |
| POST | `/api/market/wallet/deposit-notice` | XLayer USDT 充值地址 + 二维码(base64 PNG) |
| GET | `/api/market/search?keywords=&after=&trial=&max_fee=` | `service-match` 直通,原样返回 `services[]` + `searchAfter/hasMore` |
| GET | `/api/market/asp/:agentId` | profile + service-list + feedback-list 合并(缓存 5 分钟) |
| POST | `/api/market/subscribe` | `{service_id, provider_agent_id, fee_amount, fee_token_address, use_trial, auto_renew, title?, description?, mode, weight}` → `create-subscribe`(禁止 autotrade 参数)→ `subscribe-device-update` 加本机 → 写本地配置;返回 jobId 或 `funding_notice` |
| GET | `/api/market/subscriptions` | buyer 视角 ∪ 本地配置 ∪ 本地统计 |
| PATCH | `/api/market/subscriptions/:jobId` | `{mode?, weight?, enabled?, label?, this_device_receives?}` |
| POST | `/api/market/subscriptions/:jobId/cancel` / `reject` `{reason}` / `autorenew` | 对应 CLI |
| GET | `/api/market/inbox?job_id=&status=&limit=` | 耐久账本行(含 raw、parse_status、signal_id) |
| POST | `/api/market/inbox/poll` | 手动拉一次(queue transport) |
| GET/POST | `/api/market/settings` | `MarketSettings`(§2.2)+ `publisher`(§3.3) |
| GET | `/api/market/asp` | 我的 ASP 身份(可空)、服务、`subscribe-active` 订阅者、provider 视角订阅、`asp-claimable`、售后待办 |
| POST | `/api/market/asp/validate` / `register` / `activate` / `deactivate` / `update` | 注册流程;`register` 收 multipart(头像) |
| POST | `/api/market/asp/claim` | `asp-claim-rewards` |
| POST | `/api/market/asp/aftersales/:jobId` | `{decision:'agree_refund'|'dispute', reason?}` |
| GET | `/api/market/asp/deliveries?limit=` | 出站账本(主记录 + 每户) |
| POST | `/api/market/asp/deliveries/:eventId/retry` `{job_id?}` | 重发失败户 |
| POST | `/api/market/asp/preview` | 渲染一条示例投递(不发) |
| SSE | `market_delivery`、`market_publish`、`market_subscription`、`market_aftersale` | 前端增量刷新 |

存储:迁移 `00xx_market.sql` — `okx_market_delivery_in`、`okx_market_delivery_out`、`okx_market_delivery_out_job`、`okx_market_aftersale`;设置与身份缓存走 kv(`market.settings`、`market.asp_identity`、`market.in_cursor`)。

测试要求:归一化沿用现有 okx-asp-feed 测试;账本幂等(同 deliveryId 三次只一行)、游标断电续读、系统事件不进信号账本、扇出幂等(同事件重跑不重发)、失败不自动重试、paper 线程不发 order、敏感词拦截、注册字段校验、CLI 假 runner 全覆盖;端到端:假队列两行 → 信号栏两条 review_only。

## 7. 待验证 / 待拍板

1. `okx-a2a user watch --json` 作为常驻子进程是否稳定(它是给会话设计的,可能有 2 分钟 decision_request 超时语义);验证前默认 `queue`。
2. ASP 身份与 User 身份同钱包同守护,事件是否落同一队列 —— 注册后看一次。
3. **定价与试用**(建议:月订阅 + 72h 试用,金额 Jacky 定;演示可 0)。品牌名 / 头像 / 服务名与描述初稿由 asp_agent 写,发布前给 Jacky 过目。
4. `copy` 模式首发是否放开(默认 `evidence`;放开 copy 等于允许买来的信号自动开仓,虽然过我们的闸,但这是「零自动交易所写」承诺的一次修改,要 Jacky 明说)。
5. 纸面线程是否允许以 analysis 发出(建议允许但标 `paper:true`)。

## 8. 分工与顺序

- **外部评审— 后端**:§2.1 账本与 transport、§2.2 设置、§3.3 发布器、§4 asp_agent 目录与角色接线、§6 全部路由与迁移、测试。改动范围 `packages/gateway`、`packages/contracts`(类型)、`docs/demo/v3-ui-contract.md` §9.39。**不碰** `packages/webui`。
- **主线 — 前端**:`pages/market.tsx` 四栏 + 组件、nav 改名、`api/types.ts` 与 `client.ts` 对齐契约、i18n、删 follow 页;`skills/asp-agent/SKILL.md`。
- 顺序:契约 §6 先冻结(本文)→ 两边并行 → 前端先用契约 mock 接口 → 合并 → tester 跑全量 → 外部评审对抗复审 → 重编 dist → 重启 18811。
- 参赛演示路径:注册 ASP(Jacky 本人过目文案)→ 用 User #13529 订自己的服务不行(同钱包),改订 #8136 试用做「买」的演示 → 发布器开着,agent 判断实时 relay 到市场 → 页面上看到订阅者与投递账本。
