# ASP Agent / 信号市场

职责：OKX.AI 入站耐久账本、订阅设置、CLI 身份管理、按订阅者扇出发布、自动领款与人工售后。所有 CLI 进程从 `cli.ts` 启动，环境（含代理）原样继承；不使用 shell，不传 autotrade 参数。

`inbox.ts` 保留既有 ASP normalizer/兼容 feed 导出，运行时使用 MarketInbox。queue 默认只读；watch 实验性且互斥。市场账本与六记录交易闸分离，copy 仅 open 可自动执行；未知执行结果隔离等人工核对。发布器默认关；paper 只能 analysis；外部跟单线程不转发。模型 hooks 在 `audit.ts`，当前零模型调用。

契约：`docs/demo/v3-ui-contract.md` §9.39。测试不操作真实账户：

```sh
node node_modules/vitest/vitest.mjs run --root packages/gateway test/demo/market-backend.test.ts test/demo/okx-asp-feed.test.ts
npm test -w packages/gateway
npm run typecheck
```

对话读模型位于 `chat-read.ts`（§9.55）：`get_asp_overview`、`list_asp_services`、
`list_asp_tasks`、`list_asp_subscribers`、`list_market_inbox`。它只调用独立 SELECT 入口、
`cachedAspIdentity` 和已有 `AspServices.chatSnapshot()` / `ProviderTaskPoller.status()`；
不会为了读状态构造 AspAgent，不会刷新 CLI、写缓存、启动接单或推进游标。
服务和订阅/收入的远端信息取市场页已加载的快照，缺快照明确 `ready:false`；默认价格标记为建议价，不能当成实时上架报价。
错误仅保留脱敏摘要，买方/任务标识只显示末四位。验收覆盖缺表降级及 SQLite `query_only` / `total_changes`。
