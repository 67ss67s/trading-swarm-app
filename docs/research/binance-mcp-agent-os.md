# Binance Agent OS / MCP Server — 调研笔记(2026-09-02)

## 事实(来源:Binance 官方新闻稿 2026-08-20、developers.binance.com/en/docs/agent-native/mcp-server(/agentic)、crypto.news 两篇、本机未授权探测)

- **Agent OS** = Binance APIs + Binance Wallet Agentic Hub + Binance x402(可编程支付)+ Binance Skill Hub + **MCP 支持**。
- **MCP endpoint**:`https://agent.binance.com/mcp/agentic`,transport = **Streamable HTTP**。
- **鉴权**:OAuth 2.0 浏览器授权(桌面浏览器,手机不支持),**本地不存 API key**。`/.well-known/oauth-authorization-server`:
  - issuer `https://agent.binance.com`
  - authorize `https://accounts.binance.com/agentic-oauth/authorize`
  - token `https://accounts.binance.com/oauth-agentic/token`
  - grant `authorization_code`,PKCE `S256`,`token_endpoint_auth_methods_supported: ["none"]`(public client)
  - `client_id_metadata_document_supported: true`(MCP 新规范 CIMD:client_id 是一个指向元数据 JSON 的 URL);**没有**广告 dynamic client registration 端点。
  - 未授权 POST initialize → **401** + `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/gateway-mcp"`;连 `tools/list` 都要 token。
  - protected-resource 元数据只给 `resource` + `authorization_servers`,**没列 scopes_supported**;工具清单要拿到 token 后 `tools/list` 才知道。
- **Agentic 子账户**:首次授权自动创建"Agentic virtual sub";用户必须**手动在 Binance UI 划转资金**进去(Profile → Dashboard → Sub-account → Asset Management);agent **不能**把主账户资产划进子账户,**不能**提币到外部地址(没有 withdraw scope);可选只读查看主账户余额/组合;Binance UI 有 **Disconnect agents** 与**紧急全平**。
- **权限 scope 分类**(官方文案):market data / account / trade / transfer(transfer 仅子账户内部钱包间)。
- **产品**:Spot、Margin、Convert、USDⓈ-M 合约、COIN-M 合约(视账户/地区资格)。
- **行情(无需鉴权类)**:tickers、order book、K 线、资金费率——但实际端点连 initialize 都 401,所以"无需鉴权"指的是 scope 不需要 account 权限,不是免 token。
- **执行约定**:官方文档写的是"agent 复述订单(symbol/side/type/amount)并等你说 yes 再发送"——这是 prompt 层约定,**不是服务端强制**;我们的 gate 必须在代码层做确认闸。
- 兼容客户端:Claude Code(`claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic`)、Claude Desktop、Codex CLI、ChatGPT、VS Code、Grok Bot。
- **未提及**:testnet/sandbox、rate limit、错误码、地区限制、费用。Binance 能看到订单但看不到 agent 的决策过程。
- 责任:ToS 把 agent 交易风险全放用户身上;"guardrail prevents theft, not loss"。

## 对设计的直接影响
1. 交易所访问 = **MCP client over HTTP + OAuth**,不是 REST 签名。gate 需要:PKCE 流程、CIMD 或预注册 client_id、token 持久化(按 profile)、refresh、401 → 重授权、"Disconnect agents" 视作凭证吊销事件。
2. **没有 testnet**:paper 模式必须由 gate 自己模拟(用真实行情 + 本地撮合),LiveCapped 用小额子账户资金做"真实 paper"。
3. **无 ack 语义**:MCP tool call 超时/连接断后不知道订单是否已下——必须靠 `clientOrderId`(如果 MCP 工具接受)或"下单后查开放订单/成交"对账,禁止盲重试。工具是否支持 `newClientOrderId` 是 P0 要验证的问题。
4. 行情 K 线可以直接从 MCP 拿,但 gate 自己也应有本地 K 线库(公开 REST/WS 无 key 即可拉),避免每根 K 线都过 MCP+token。
5. 工具名/参数直到拿到 token 才能确定 → **P0 第一件事**:完成一次 OAuth,`tools/list` 落盘到 `docs/research/binance-mcp-tools.json`,并按其形状写 adapter。

## 补充:MCP TS SDK 对 Binance 鉴权流程的支持(2026-09-02 本机验证)
- `@modelcontextprotocol/sdk@1.30.0`(npm latest)的 `client/auth.js` 已实现 **CIMD**:当 AS 元数据 `client_id_metadata_document_supported === true` 且 provider 提供 `clientMetadataUrl`(必须 HTTPS、非根路径)时,直接用该 URL 作为 `client_id`,跳过动态注册——正好匹配 Binance 的 AS 元数据。
- 需要实现的 `OAuthClientProvider`:`redirectUrl`、`clientMetadata`、`clientMetadataUrl?`、`clientInformation()`、`tokens()/saveTokens()`、`redirectToAuthorization(url)`、`saveCodeVerifier()/codeVerifier()`、`invalidateCredentials?(scope)`、`prepareTokenRequest?`。gate 用文件持久化(`~/.trading-swarm/oauth/binance.json`,0600)。
- 待 P0 实测的两条路:①CIMD——需要公网托管一份 client 元数据 JSON(可放 <bridge-domain>,内容含 client_name / redirect_uris=[http://127.0.0.1:<port>/oauth/callback] / token_endpoint_auth_method=none / grant_types / response_types);②若 Binance 接受任意 client_id + 回环 redirect,则免托管。哪条通了写进 WP1 报告。
- 本机 npm 缓存目录被 root 文件污染,`npm install` 需加 `--cache <其他目录>` 或先 `sudo chown -R 501:20 ~/.npm`(实施 session 第一天会撞到)。

## MCP 与传统 API key 的自由度对比(2026-09-02 口径;"未知"= 拿到 token 跑 tools/list 前无法确认)
| 维度 | API key(8794 现用) | 官方 MCP / Agentic 子账户 |
|---|---|---|
| 作用账户 | 主账户或任意子账户,权限勾选(读/现货/合约/提币+IP 白名单) | **只能**是自动创建的 Agentic 子账户;主账户可选只读;agent 不能把主账户资产划进来 |
| 资金 | 可提币(若勾权限)、可划转 | 无提币 scope;transfer 只限子账户内部钱包间 |
| 产品 | 全部 REST/WS 端点(现货、杠杆、U 本位/币本位、期权、算法单/TWAP、批量单) | 官方宣称 Spot / Margin / Convert / USDⓈ-M / COIN-M;具体订单类型(STOP/TP/TRAILING/条件单/批量/算法单)、杠杆与保证金模式切换、持仓模式切换是否暴露 → **未知** |
| 订单身份 | `newClientOrderId` 自定义 + `origClientOrderId` 查撤,完整幂等 | **未知**(这是 A1 的 go/no-go 项) |
| 实时推送 | listenKey 用户数据流 WS(成交/持仓/余额秒级推送)+ 行情 WS | MCP 是请求/响应;官方未提 WS 或订阅;成交只能轮询 → 对账延迟与配额压力 |
| 限频 | 文档化(权重/分钟、订单/秒、订单/日,响应头可读) | **未文档化**,只能自适应退避 |
| 测试环境 | testnet / demo-fapi | **没有** |
| 鉴权 | key+secret 本地签名,可 IP 白名单 | OAuth 浏览器授权(桌面),token 刷新/撤销,Binance UI 可一键 Disconnect / 紧急全平 |
| 可见性 | Binance 只看到订单 | 同样只看到订单,看不到 agent 决策过程 |
| 执行约定 | 无 | 文档要求 agent"复述订单等 yes"(prompt 层约定,非服务端强制;standing authorization 是否合规待问) |
| 生态 | 任何语言 SDK | Claude/Claude Code/Codex/ChatGPT/VS Code/Grok 直连;自建客户端要实现 MCP OAuth(TS SDK 1.30 已支持 CIMD) |
结论:MCP 的"自由度"是**刻意小于** API key 的——它拿走了提币、跨账户划转、主账户操作,换来无 key 与可一键断开;交易能力上限等于它暴露的工具集,不等于 REST 全集。若产品需要 REST 全集(算法单、批量单、用户数据流秒级成交),那就是"人工下单走 REST 直连"的场景,对应设计 §2 末尾的 Rust 执行服务分支。
