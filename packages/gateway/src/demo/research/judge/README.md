# IR judge

JSON Schema 唯一源为 `packages/contracts/schema/research.json`。IR v1 不补字段、不改变哈希；v2 必须带 `judge` 和 `order`。首版规则只支持概率分布的 all 合取，灰区、模型错误均 skip。

- `pure.ts`：`buildJudgeState / normalizeAnswers / evaluateJudgeRule`。固定过去 100 根已收盘/已可用 bar；不取行情、不接未来标签或任意对象路径。趋势是 SMA20/SMA50，波动是过去14根平均 true range/close，量比为最近20根均量；不是旧 judgment-replay 的 EMA/ATR 口径。`features.funding` 预留但尚无历史适配，不能伪造0。
- `index.ts`：`judgeCandidate(input,deps)`，首次响应钉住，缓存覆盖问题、状态、模型配置、序列化及超时；规则改变允许复用回答，最终决策单独绑定完整 IR。`recorded_only` 从不调用 provider。
- `store.ts` + 0047：`BEGIN IMMEDIATE` 同事务 claim 与原子最大费用预留；未知收费不退预留。真正返回实际费用超过供应商承诺上界时照实入账并封锁后续请求，不能伪造预算未超。
- `filter.ts`：matrix 服务用 `runWithJudge` 或 `judgeFilter`；返回/回调全部代码候选，包括主动 skip、灰区、错误；订单核先产生代码意图，再判断，最后模拟成交。
- `purge.ts`：执行口径最大标签/持仓与挂单等待；runPool 对隔离空档/封存开发视图的每个新变体执行前强制检查。旧无空档的连续历史窗口仍为MTM分析，不冒充隔离研究。
- `stubs.ts`：四类离线桩，成本明确为0，不冒充真实模型。

`DecisionProvider` 按 §9.52 `DecisionClient` 编程，不读凭证。真实 client 必须由 owner 配置 `maxRetries:0` 并冻结连接/模型；`fromDecisionClient` 不会也不能修改 client 私有设置。`RecordedResponse` 可附供应商 `raw_response`、`provider_request_id`；当前 §9.52 最小接口只有解析后的 `DecisionResult`，缺这些字段时钉住的是 client 响应，request ID 记 null，不伪称拿到了供应商原文。`model_revision` 是上游配置钉住值；若 provider 只提供 latest 别名，不能证明服务端权重未变化。

预算 `AtomicCallBudget.create(db,id,max_calls,max_usd)` 与 `JudgeDecisionStore(db)` 必须同连接。恢复只在旧 worker 已确定停止后调用 `interruptBudget(id)`：遗留 pending 变 unknown、保留预留，不重抽。取消挡住新预留；resume 不清账。预留前取消不钉最终决策；响应已存但取消时返回的临时状态也不钉住，恢复从同一raw完成决策。并发重复请求等待原请求，进程死后 pending 等待超时抛出恢复错误，不把调度时序当作最终 skip。

```sh
npm exec -w @trading-swarm/gateway -- vitest run test/demo/research/study/judge.test.ts test/demo/research/study/g4-replay.test.ts test/demo/research/study/g5-budget.test.ts
```

同一候选状态/记录响应的一致性不代表账户路径和真实成交价一致。粗 bar 回测仍无法验证在线决策延迟，实盘延后到阶段闸、额度与授权链满足。

claim成功后、decide前的取消保守记unknown并保留预留，不重发；只有预留前取消才能恢复首次请求。
