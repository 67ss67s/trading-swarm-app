# exchange-mcp —— Binance MCP / OAuth 半边(A1)

execd 里唯一持有 OAuth token 的地方。职责:发现(PRM → AS 元数据)、PKCE 授权码流程(public client,client_id 走 CIMD)、token 文件原子替换(`~/.trade-gate/secrets/oauth-binance.json`,0600)、refresh 单飞状态机、MCP Streamable HTTP 客户端(手写,不用 rmcp)、`tools/list` 快照钉版与漂移守卫。

## 模块

| 模块 | 内容 |
|---|---|
| `discovery` | 401 的 `WWW-Authenticate` → PRM → AS 元数据;校验 issuer / S256 / `none` / CIMD |
| `oauth` | PKCE、authorize URL(含 RFC 8707 `resource`)、回环回调服务器(一次性,校验 state)、token 交换/刷新、`probe_client`(bogus code 打 token 端点看 invalid_client 还是 invalid_grant) |
| `token_store` | 文件 0600、写临时文件 + rename、`TokenState {Missing,Fresh,Expiring(<10min),Expired,Revoked}` |
| `auth` | `AuthManager`:`access_token()`(需要时单飞刷新)、`refresh_for(observed)`、invalid_grant → 持久化 Revoked |
| `mcp` | `McpClient`:initialize(`Mcp-Session-Id`、协议版本协商)、`tools/list` 分页、`call_read`(401 刷一次/会话丢重建一次/超时重试一次)、`call_write`(**永不重试、永不重放**) |
| `snapshot` | `ToolsSnapshot { tools_hash = sha256(canonical(tools 按 name 排序)) }`、`drift_check` |
| `classify` | 探针用:按名字/描述猜写类工具、找 `clientOrderId` 形状的字段、找子账户标识工具 |
| `secret` / `error` / `http` | 脱敏字符串、错误分类(`Unauthorized/SessionLost/RateLimited/Transport/InvalidClient/Revoked/WafChallenge…`)、系统代理 reqwest |

## 探针 `tgate-mcp-probe`

```
CARGO_TARGET_DIR=target/exchange-mcp cargo run -p exchange-mcp --bin tgate-mcp-probe -- <子命令>

discover                         # 只读:401 挑战 + PRM + AS 元数据(已对真实端点验证通过)
probe-client [--client-id URL]   # 只读:bogus code 打 token 端点。invalid_client = CIMD 文档没上线/不一致;invalid_grant = Binance 接受了我们的 client_id
oauth [--print-only] [--no-browser] [--port 18801] [--scopes "a b"] [--client-id URL]
                                 # 完整授权:打印/打开 authorize URL → 监听 127.0.0.1:18801/oauth/callback → 换 token → 存 0600
status | refresh | revoke        # token 文件状态 / 强制刷新 / 删本地 token(服务端撤销在 Binance UI「Disconnect agents」)
tools [--out docs/research/binance-mcp-tools.json]
                                 # initialize + tools/list → 快照(含 hash)落盘 + 自动标注写类工具/clientOrderId 字段/子账户标识工具
call <tool> [json]               # 只允许读类工具;写类要 --i-know-this-writes(A 阶段不用)
```

## 真实实测清单(A1 go/no-go 的输入,见 `docs/research/a1-go-nogo.md`)

1. CIMD 文档上线后 `probe-client` 是否变成 invalid_grant;
2. `oauth` 时 Binance 接受带端口还是不带端口的回环 redirect(文档里两种都列了);
3. token 响应是否有 `refresh_token` / `expires_in` / `scope`(AS 元数据未声明 refresh grant);
4. `tools` 的数量、hash、写类工具的 inputSchema 里有没有 `clientOrderId`/`newClientOrderId`;
5. 有没有暴露子账户 id/email 的工具;`Mcp-Session-Id` 行为;401/429 行为。

## 测试

`CARGO_TARGET_DIR=target/exchange-mcp cargo test -p exchange-mcp`(26 条:假 AS 的授权码/刷新/撤销/单飞/原子替换/权限、回调 state 校验、脱敏)。**不碰真实网络**;`-- --ignored` 有两条真连 well-known 端点。
