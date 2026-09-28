# trade-gate Web UI

React / shadcn / react-query 前端，通过 gateway API 展示交易线程、意图审批和工作流设置。自动仓位在 workflow form 中选择关/只建议/采用，审批意图卡展示代码 sizing 与 agent 理由；不计算或提交模型生成的数量。

类型检查：在此目录运行 `npx tsc --noEmit -p .`。契约见 `docs/demo/v3-ui-contract.md`。

高级页面的市场远端读取显示缓存时间及刷新状态；日志页用稳定游标分块翻页，最新页每 5 秒更新。
可用 `npx vitest run --root packages/webui test/market-adapt.test.ts test/market-subscriptions.test.ts` 验证适配，
`npm run typecheck -w @trade-gate/webui` 检查页面类型。
