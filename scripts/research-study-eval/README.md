# Matrix / judge 离线评测

从仓库根运行 `node scripts/research-study-eval/run.mjs --gate g1 --network deny`。
完整安慰剂用 `--profile release`（每种零假设1000个独立 replicate，首轮不要运行）。
`--gate g3` 默认只输出采集协议，传 `--manifest recorded.json` 才分析已录账户日收益。
G4/G5 使用对应的 Vitest 工程测试；G4 `--profile release` 扩大到10400根行情。
实现见 `packages/gateway/scripts/research-study-eval/`；统计口径、费用及限制见 `docs/research/chat-to-strategy-eval-protocol.md`。
