# 离线评测 G1 / G3 / G4 / G5

`nulls.ts` 生成相关鞅随机游走 N1 与开发数据同步块重抽+共同独立符号 N2。`statistics.ts` 提供精确二项 CP 单侧上界、Holm 与配对时间块 bootstrap。`g1.ts` 必须注入完整 matrix study adapter；小规模 CI 固定输出 `insufficient_evidence`，不把少量无误放当成统计通过。`g3.ts` 定义真实调用协议及录制账户日收益的离线比较。

```sh
npm exec -w @trading-swarm/gateway -- vitest run test/demo/research/study
node packages/gateway/scripts/research-study-eval/run.mjs --gate g1 --profile release --provider stub --null-replicates 1000 --network deny
node packages/gateway/scripts/research-study-eval/run.mjs --gate g3 --network deny
```

完整 G1 及 G3 真实调用本轮不跑。G4/G5 工程测试使用内存库或临时目录，不读写运行中的 demo 状态目录。具体协议见 `docs/research/chat-to-strategy-eval-protocol.md`。

## Jev 适配 v2

`g3-collect.ts` 提供≤3冻结候选四臂采集，`g3-analyze.ts` 提供共享资本/约束的每日净盯市回放和配对块bootstrap；旧六臂输入仍兼容。`g3-fixture.ts` 仅供离线桩。真实manifest及执行路径由冻结研究/执行器导出，不从实时demo读取。库的pending恢复须独占权，CLI提供PID锁。费用上界与DeepSeek token单价必须冻结核验。

```sh
node packages/gateway/scripts/research-study-eval/jev-g3.mjs --mode rehearse --network deny --out-dir /tmp/jev-g3-rehearsal --max-usd 2 --max-calls 12000
npx vitest run packages/gateway/test/demo/research/study/g3-collect.test.ts --maxWorkers=1
```

真实命令、输入契约和已知有损点见 `docs/research/jev-adapt-v2-2026-09-25.md`。
