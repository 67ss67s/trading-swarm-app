# 执行层接币安 Agentic MCP:操作台设计(2026-09-04)

> 起因:Jacky 在 Claude Code 里 `claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic`,想让 gate 通过它做实盘执行,gate 变成一个「操作台」:前端点一下跳转币安授权,agent 自动跑,尽量省钱,且 claude 不做多余动作;同时把 codex、grok 的接口也接上。

## 0. 当天查明的事实

| 事实 | 出处 | 影响 |
|---|---|---|
| MCP 端点 `https://agent.binance.com/mcp/agentic`,Streamable HTTP,未带 token 返回 401 + `resource_metadata` | curl | gate 可以直接做 MCP 客户端 |
| 授权服务器元数据:`authorize` 在 accounts.binance.com,`token_endpoint_auth_methods_supported=["none"]`,只支持 `authorization_code`(**没有 refresh_token**),PKCE S256,`client_id_metadata_document_supported=true`,**没有动态注册** | `/.well-known/oauth-authorization-server` | 客户端身份 = 一个 https URL 上的 JSON 文档(CIMD);token 过期只能重新授权 |
| Claude Code 支持 CIMD,已在 Jacky 家目录 project scope 注册过 `binance-mcp-server`,钥匙串里有 accessToken 但 `claude mcp get` 说 Needs authentication(过期) | `claude mcp get`(cd ~) | claude 路径可用,但要 Jacky 先在交互式 `claude` 里 `/mcp` 重新登录一次 |
| `codex mcp add … --url` 成功,但 `codex mcp login` 报 "Dynamic client registration not supported" | 本机 codex | **codex 路径目前走不通**(等 Codex 支持 CIMD 或 bearer 环境变量拿到 token) |
| 本机没有 grok CLI;币安文档里的 "Grok Bot" 是 Grok 应用自己的连接器,不是可 spawn 的进程 | which / 文档 | **grok 没有可接的接口**;若 xAI 出 CLI 再说 |
| 工具清单(名称/参数)文档没写,页面是 JS 渲染,拉不到;要 tools/list 必须先有 token | WebFetch / llms-full.txt | 执行映射只能在授权后再定 |
| 从钥匙串读 Claude 的 token 复用 | 评估 | 也不该这么做:另一个应用的凭证、无 refresh、脆弱 |
| **(2026-09-05)带着网关自己的 client_id 打开币安同意页,币安直接拒:「The AI Agent you are using is not currently supported (**3346001**)」** | 真机点了一次 | 币安**按 client_id 白名单**放行 agent,不是 PKCE/CIMD 哪里写错了。Claude Code 在白名单里,网关不在 → **A 路(gate 自己做 OAuth 客户端)今天走不通**,直到币安把网关加进名单 |

## 1. 三条路,选两条

**A. gate 自己做 OAuth 客户端 + 直接调 MCP(零 LLM 成本,但 2026-09-05 起被币安挡死:3346001)**
- ⛔ **现状:代码全都写完并可用,但币安的同意页不接受网关的 client_id**(3346001,见 §0)。所以默认不再设 `TG_BINANCE_OAUTH_CLIENT_ID`(start-demo.sh 里注释掉了),`POST /api/execution/connect` 也不再返回同意页 URL;只有 `TG_BINANCE_OAUTH_FORCE=1` **且**配了 client id 时才会再走这条路(留给「币安哪天把我们加进白名单了」的复测)。`mcp` 选项在 UI 里给出的理由就是这句话。下面是等白名单通过后的原设计:
- `binance-oauth.ts`:PKCE + CIMD。client_id 是一个 https URL,内容由 `GET /oauth/binance/client-metadata.json` 给出(`redirect_uris` = `http://127.0.0.1:18800/oauth/binance/callback`,`token_endpoint_auth_method=none`)。本机 gateway 不是 https,所以把这份 JSON 放到任一静态 https 地址(例如 Jacky 的 DO 服务器 `https://<bridge-domain>/trading-swarm/client-metadata.json`),把该地址设为 `TG_BINANCE_OAUTH_CLIENT_ID`。Claude Code 自己就是用 loopback redirect + CIMD 通过币安授权的,所以币安接受 loopback。
- 前端「连接币安」→ `POST /api/execution/connect` 返回 `url` → 新标签页打开币安同意页 → 回调到 gateway → token 存 `demo_kv`(`binance.oauth.token`)→ SSE `execution.changed`。没有 refresh grant,过期(看 `expires_in`)后 UI 提示重新连接。
- `mcp-client.ts`:initialize / tools/list / tools/call,处理 `mcp-session-id`、SSE 帧、401、404 重连。
- 授权后第一件事是 `GET /api/binance/tools` 把工具清单落盘(`docs/demo/binance-mcp-tools.json`),然后写 `McpDirectBackend`(ExecBackend → 对应工具),每笔下单就是一次 HTTP,不经过任何模型。

**B. 由 agent CLI 执行(claude,已实现为 `agent_mcp` 后端)——✅ 现在唯一能用的路**
- Jacky 的决定(2026-09-05):**连接走 Claude Code**——「弹 claude 再过去,默认 sonnet 去连」。`POST /api/execution/connect` 用 osascript 弹一个 macOS 终端窗口跑 `cd ~ && claude "/mcp"`,人在那个窗口里选 `binance-mcp-server → Authenticate`,浏览器同意后回网关点「检查连接」。网关**不读任何凭证**(不碰钥匙串、不碰 ~/.claude),token 全程在 CLI 手里。弹不出来(非 macOS / osascript 失败)就退回显示手动步骤。
- 每个写操作 spawn 一次 `claude -p --model sonnet` + `--mcp-config`(同名同 URL 复用 Claude 的 OAuth 会话)+ `--allowedTools mcp__binance-mcp-server__*` + 禁掉全部本地工具 + `--max-turns 6`,任务 JSON 只描述这一笔,要求只回一个 JSON 回执。读账户走缓存(默认 5 分钟,写后失效)。
- 成本口径:**每个写操作 = 一次 sonnet 会话**(下单/止损/止盈/撤单/改杠杆各一次),读账户 5 分钟缓存内 0 次、缓存过期一次,查订单 30 s 缓存,行情/合约规则走公开 REST 永远 0 次。一次会话大约几千输入 token 级别,走订阅额度;`exec_agent_model` 默认写死 `sonnet`(workflow 默认值 + `GET /api/execution` 的 `agent.model`),留空时 `AgentMcpBackend` 也仍然传 `--model sonnet`。
- 优点:今天就能用(Jacky 弹终端 `/mcp` 登录后),不需要托管 CIMD 文档;缺点:每笔下单一次 sonnet 调用(订阅额度)、慢(10–30 s)、回执靠模型转述。
- codex 版本同一接口(`exec_agent_cli=codex`),但当前 Codex 登不上币安,UI 标为不可用。

**C. 借 Claude 钥匙串里的 token 直连**:不做(见事实表)。

## 2. 省钱

- 判断侧才是花钱大头:今天 662 次判断 ≈ 866k 输入 token(GLM-5.3)。加了 `daily_judgment_cap`(默认 300,0 不限)和顶栏「今日判断 n/cap · ≈¥x」。
- 执行侧:A 路零模型成本;B 路每笔一次 sonnet;读账户缓存。
- 绝不让执行 agent 自己「看盘决定」:任务 JSON 里已经写死 symbol/方向/数量/价格/clientOrderId,模型只负责把它翻译成 MCP 调用。

## 3. 状态(2026-09-05)

- 已做:`binance-oauth.ts`、`mcp-client.ts`(+ 测试);`agent_mcp` 后端与 `/api/execution*`;前端执行卡片、顶栏大脑切换、交易页币种列表、成本表;A 路的 `McpDirectBackend` / `mcp-map.ts` / `/api/binance/map*` 五条路由 / 前端「币安直连」区块 / 配套测试也都写完了(细节见 `docs/demo/v3-ui-contract.md` §9.9)。
- **变更:A 路被币安挡死(3346001)**,不是代码问题,是 client_id 白名单。所以:
  - `start-demo.sh` 不再默认导出 `TG_BINANCE_OAUTH_CLIENT_ID`(注释保留,等白名单);
  - `POST /api/execution/connect` 默认不再返回同意页 URL,只有 `TG_BINANCE_OAUTH_FORCE=1` + 配了 client id 才会;
  - 前端「币安直连」整块**默认折叠**并挂一行说明(代码原样留着),`mcp` 选项的理由统一为「币安未把网关列为受支持的 Agent(3346001),直连不可用;用 agent_mcp(Claude)」。
- **现在的点击路径(Jacky 照着点)**:

  执行卡 →「用 Claude 登录币安」→ 网关弹出一个终端窗口(里面已经在跑 `cd ~ && claude "/mcp"`)→ 在 MCP 面板里选 `binance-mcp-server` → **Authenticate** → 浏览器里同意 → 回 trading-swarm 点「检查连接」(应该变「已连接」)→ 执行后端选 **`币安官方 MCP(agent CLI 驱动)`**(`agent_mcp`)。
  模型不用改:默认就是 sonnet(执行卡的「模型」框会显示 `sonnet`,提示「默认 sonnet,便宜」)。

- B 路(`agent_mcp`)是现在唯一活的执行链路;C 路(借钥匙串 token)结论不变:不做。codex(`codex mcp login` 只支持动态注册)、grok(没有可接的接口)结论也不变。
