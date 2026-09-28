# 九个 Agent 的身份、循环与对话线程(2026-09-25,jacky-27)

契约:docs/demo/v3-ui-contract.md §9.55。后端 astra(gpt-6-astra xhigh)落地,前端 jacky-27 做楼层对话框 + Agent 页选择器。

## 0. 问题(Jacky 截图原话的拆解)

1. Agent 页的会话下拉**不是九个 agent**:楼层每点一次「和它对话」就 `POST /api/chat/sessions {role}` 新建一个会话,于是下拉里出现两个 `@MARKET ASP Agent`、两个 `@BOOK Portfolio Manager`,缺了其余角色。
2. 问 ASP Agent「你是 asp」,它答「我是交易 agent 主会话」。根因在 `chat.ts`:
   - `SYSTEM` 开头写死「你是 trade-gate 的交易 agent 主会话」,所有角色共用;
   - `ROLE_PERSONA` 只有 8 个角色,**没有 `asp_agent`**,所以 ASP 会话等于主会话;
   - 所有角色拿到同一份工具清单,**没有任何 ASP / 信号市场工具**,它读不到身份 #13866、7 个服务、订阅者、收件箱、接单轮询、领款——所以「一无所知」;
   - 团队介绍里写「八个角色」,不含 ASP。
3. 楼层点 agent 会跳走到 Agent 页,不能在楼层里直接对话。

## 1. 目标形态

- 名册固定 = `BOT_ROLES` 九个:gate_captain / radar / thread_manager / strategy_lab / portfolio_manager / risk_sentinel / reviewer / executor / asp_agent。
- **每个 agent 一条规范线程**:gate_captain = `default`(兼容老主会话),其余 = `agent:<role>`。楼层对话框和 Agent 页读写同一个 session id → 天然同步(SSE `chat.message` 已按前缀失效)。
- 每个 agent 有:
  - **AGENT.md**(身份):我是谁、负责什么、不负责什么(找谁)、红线、我的循环、我能调的工具、口径。进系统提示;也通过 API 给前端展示。
  - **loop**:它在后台自己跑的那条工作循环(触发 → 步骤 → 产物 → 交接)的**实时状态**(idle/running/paused/disabled/error、当前节点、上次/下次运行、待阅交接数)。
  - **graph**:同一条循环的**节点/边**(含跨 agent 的交接边),前端画成小流程图并点亮当前节点。
  - **tools**:按角色白名单;提示词里只列白名单内的工具,调用白名单外的工具 → 工具失败「不属于我,找 @XXX」。
- 自由会话(用户手动「新建会话」)保留,role=null 时按 gate_captain 口径。

## 2. 后端改动(astra)

### 2.1 AGENT.md 文件
- 位置 `packages/gateway/agents/<role>.md`(九个文件,中文为主;**asp_agent.md 里对外名称/服务名保持英文原样**)。运行时按 `import.meta.url` 回溯到包根解析(src 与 dist 都能找到;不需要构建拷贝)。读取带缓存 + mtime 失效,文件缺失时回退到 `bots.ts` profile 的 description,不 fatal。
- 固定小节(前端按标题切块,标题必须一字不差):
  `# <Name>` / `## 我是谁` / `## 我负责` / `## 我不负责(找谁)` / `## 红线` / `## 我的循环` / `## 我能调的工具` / `## 口径`。
- 内容必须来自代码和文档的事实,不要编:
  - asp_agent:读 `src/demo/asp-agent/*`、`docs/design/asp-market-2026-09-20.md`、`docs/submission/try-on-okx-ai.md`、记忆里的事实(身份 #13866「Trading Swarm」月订阅 + 72h 试用、7 个对外服务按 serviceId 注册、provider-tasks.ts 唯一接单轮询、publisher 按订阅者扇出、inbox 入站账本、领款、售后人工、ASP 交付内容一律英文、上架审核中过审后 activate)。**会变的数字(审核状态、订阅数、余额)不写死**,写「用 get_asp_overview 查」。
  - 其余八个:从 `bots.ts` profile(capabilities、approval_boundary)、`team-agents.ts`、`captain.ts`、`screener.ts`、`reviewer-agent.ts`、`execution-agent.ts`、`sizing-agent.ts`、`risk*.ts` 提炼。
- 「我能调的工具」小节由代码生成还是手写都行,但**必须和 2.3 的白名单一致**(加一条单测对齐)。

### 2.2 系统提示重构(chat.ts)
- 拆成:`BASE`(产品 = Trading Swarm,用户是操盘手,中文简短数字化,红线通用条款,九人团队一行一个)+ `AGENT.md 全文` + `该角色白名单工具的说明` + 该角色的技能段(`STRATEGY_LOOP_SKILL` 只给 strategy_lab 和 gate_captain;READONLY 段按白名单过滤)。
- 删掉「你是 trade-gate 的交易 agent 主会话」这种角色无关的自称;gate_captain 的 AGENT.md 自己写「我是总协调,也是默认会话」。
- 团队段改成九个,含 ASP Agent。
- `ROLE_PERSONA` 并入 AGENT.md 后删除(或只留作 AGENT.md 缺失时的兜底)。

### 2.3 工具白名单 + ASP 工具
- 新文件 `src/demo/agent-registry.ts`:`AGENT_REGISTRY: Record<BotRole, { name; callsign; tagline; tools: string[]; skills: string[]; loop: LoopSpec }>`,唯一口径。callsign 与前端现有一致:HELM RADAR THREAD LAB BOOK SENTINEL AUDIT EXEC MARKET。
- gate_captain 白名单 = 全部工具(总协调)。其余按职责给(参考现有 ROLE_PERSONA 里的「常用」),每个角色都有 get_state / recall / get_team 这类通用只读。
- `runChatTurn` 执行前校验白名单;白名单外 → `{ok:false, error:"not_my_tool: <tool> 属于 @<CALLSIGN>,可以去找它"}`(用注册表反查归属)。
- **新增 ASP 只读工具**(实现调 AspAgent / 市场 store 现成读函数,零写入;结果带 `links:[{label:'信号市场',href:'#market'}]` 放最前):
  - `get_asp_overview{}`:身份(agent id / 名称 / 审核或上架状态)、已注册服务(serviceId、名称、价格/计费、是否启用)、订阅者数与分组计数、发布器开关与最近发布、接单轮询(provider-tasks)最近一次时间与待处理数、可领款(claimable)、最近错误。任一块读失败就该块 `{ready:false, reason}`,其它照出。
  - `list_asp_services{}`:7 个服务逐个(serviceId、名称、说明、计费、注册状态、最近交付时间/次数)。
  - `list_asp_tasks{"status":"open|all","limit":20}`:provider 接单/交付记录(按次单、订阅单),含投递状态与回查结果。
  - `list_asp_subscribers{"limit":20}`:订阅者列表(脱敏到可显示的程度,按 group)。
  - `list_market_inbox{"limit":20}`:买方收件箱(入站信号)最近条目与状态。
  - ASP 的写动作(activate、发布、领款、售后)**这版不给模型**,AGENT.md 里说明「在信号市场页由你点」,回复附 `#market` 深链。
- 其他角色不拿 ASP 工具;gate_captain 拿 `get_asp_overview`。

### 2.4 规范线程
- `agentSessionId(role)`:gate_captain → `default`,其余 → `agent:<role>`。
- 启动时 upsert 九条规范会话(title = 注册表 name,role = role;`default` 补 role=gate_captain 语义但**不改其 id**)。
- `POST /api/chat/sessions {role}` → **幂等返回规范会话**(不再新建)。不带 role 的照旧新建自由会话。
- 规范会话不可归档/删除(409 `canonical_session`),只能清空(`POST /api/chat/reset {session}`)。
- 历史遗留的 ad-hoc 角色会话(role 非空、id 非规范):迁移时**归档**,不删、不搬消息(`0052_*.sql` 或启动时代码处理,二选一,写明)。
- `GET /api/chat/sessions` 返回的 ChatSession 增加 `canonical: boolean`。

### 2.5 对话状态事件(给「正在输入」)
- SSE 新事件 `chat.status`:`{ session_id, role, state: 'queued'|'thinking'|'tool'|'idle'|'error', tool: string|null, at }`。入队 → queued;brain.complete 前 → thinking;执行工具前 → tool(带名);回复落库后 → idle;异常 → error。
- `GET /api/agents` 的 `chat` 字段给当前值(进程内存即可,重启归 idle)。

### 2.6 名册与循环接口
- `GET /api/agents` → 九张 AgentCard(顺序 = 注册表顺序)。
- `GET /api/agents/:role` → AgentCard + agent_md 原文 + graph + 最近 10 次 run + 交接进/出各 10 条。未知 role → 404 `unknown_role`。
- loop 实时状态从 `bots.runs({role})`、`botEnabled(role)`、各调度器已有字段推导:
  - status:disabled(profile 关)/ paused(工作流 paused 且该角色受它影响)/ running(有 finished_at 为空的 run,或该角色的内部 running 标志,如 labIsRunning)/ error(最近一次 run failed 且之后没成功)/ idle。
  - current_node:running 时给图里的节点 id(拿不到细粒度就给该循环的「work」节点);否则 null。
  - next_run_at:有定时器的角色按上次 + 周期算(TeamAgents 30min tick、screener、info/heartbeat、provider-tasks 轮询等);算不出给 null(**可为 null,前端要处理**)。
- LoopSpec/graph 写在注册表里(静态),节点 kind ∈ trigger | read | code | model | gate | handoff | output | human。跨 agent 的边用 kind=handoff 的节点带 `to_role`。每个角色 4–8 个节点,讲真实流程,不画没实现的东西。

### 2.7 不做
- agent 之间互相直接对话 / 子轮调用。
- ASP 写动作开放给模型。
- 每角色单独模型(仍走 `brainForRole('chat')`)。

## 3. 验收(astra 自测)
- 单测:注册表九个角色齐全、callsign 唯一;每个 AGENT.md 存在且含八个固定标题;AGENT.md「我能调的工具」与白名单一致;白名单外调用被拒且提示归属;`POST /api/chat/sessions {role}` 连调两次返回同一 id;规范会话删/归档 409;asp_agent 系统提示里含「ASP」「Trading Swarm」且不含「主会话」;`get_asp_overview` 在各块缺表时返回 ready:false 不抛;`chat.status` 事件顺序 queued→thinking→(tool)→idle。
- 全套 gateway vitest 绿 + `npm run typecheck` 绿(webui 如有类型联动由前端侧修)。
- 用 18811 的真库只读跑一次:`node -e` 或脚本打印九个 agent 的系统提示长度、asp_agent 的 get_asp_overview 结果(不调模型)。**不重启 18811**,重启由 jacky-27 协调。
- 报告写 `.codex-reports/agent-roster.md`:改了哪些文件、每个角色白名单、asp 工具各读的是哪个函数、没做的、坑。
