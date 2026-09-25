# ASP Agent / 信号市场

职责：OKX.AI 入站耐久账本、订阅设置、CLI 身份管理、按订阅者扇出发布、自动领款与人工售后。所有 CLI 进程从 `cli.ts` 启动，环境（含代理）原样继承；不使用 shell，不传 autotrade 参数。

`inbox.ts` 保留既有 ASP normalizer/兼容 feed 导出，运行时使用 MarketInbox。queue 默认只读；watch 实验性且互斥。市场账本与六记录交易闸分离，copy 仅 open 可自动执行；未知执行结果隔离等人工核对。发布器默认关；paper 只能 analysis；外部跟单线程不转发。模型 hooks 在 `audit.ts`，当前零模型调用。

契约：`docs/demo/v3-ui-contract.md` §9.39。测试不操作真实账户：

```sh
node node_modules/vitest/vitest.mjs run --root packages/gateway test/demo/market-backend.test.ts test/demo/okx-asp-feed.test.ts
npm test -w packages/gateway
npm run typecheck
```
