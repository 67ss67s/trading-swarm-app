# 离线评测 G1 / G3 / G4 / G5

`nulls.ts` 生成相关鞅随机游走 N1 与开发数据同步块重抽+共同独立符号 N2。`statistics.ts` 提供精确二项 CP 单侧上界、Holm 与配对时间块 bootstrap。`g1.ts` 必须注入完整 matrix study adapter；小规模 CI 固定输出 `insufficient_evidence`，不把少量无误放当成统计通过。`g3.ts` 定义真实调用协议及录制账户日收益的离线比较。

```sh
npm exec -w @trading-swarm/gateway -- vitest run test/demo/research/study
node packages/gateway/scripts/research-study-eval/run.mjs --gate g1 --profile release --provider stub --null-replicates 1000 --network deny
node packages/gateway/scripts/research-study-eval/run.mjs --gate g3 --network deny
```

完整 G1 及 G3 真实调用本轮不跑。G4/G5 工程测试使用内存库或临时目录，不读写运行中的 demo 状态目录。具体协议见 `docs/research/chat-to-strategy-eval-protocol.md`。
