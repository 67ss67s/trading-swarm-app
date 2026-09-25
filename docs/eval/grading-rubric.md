# Eval 实现打分表(给第三方 agent 用)

对 `packages/eval-a`(实现 A)与 `packages/eval-b`(实现 B)各打一遍,每项 0-5 分并写一句依据(引用文件:行或命令输出),最后给总分与「建议采用哪套 / 合并哪些部分」。

1. **规格覆盖**:`docs/eval/README.md` §4 的 16 项指标各自实现了没有(NOT_IMPLEMENTED 也算诚实但扣分)。
2. **硬不变量的检测力**:向 case 里故意注入未来 K 线数值 / 伪造 evidence_refs / 在 review case 里让桩输出 PROPOSE,能否被抓住(实际动手注入,不看文档)。
3. **可复现**:同一 cases 跑两次 report 完全一致?缓存命中率?seed 生效?`run` 期间零网络?
4. **镜像变换正确性**:镜像 case 的 K 线是否严格 p → 2p₀ − p,高低是否互换,量不变,as_of 一致。
5. **outcome 模拟正确性**:手算一个 PROPOSE case 的 R 结果与代码一致;同根同时触及止损止盈的处理。
6. **代码质量**:只复用 `@trading-swarm/gateway` 的 demo 导出、无复制粘贴 context builder;类型严格;错误处理。
7. **测试**:vitest 数量与是否覆盖上面 2/4/5。
8. **报告可读性**:`report.md` 一眼能看出 PASS/FAIL 与样例。
9. **运行成本**:一次 30 case 的 pi run 花了多少 token/时间,缓存后再跑多快。
10. **诚实度**:README 的「已知局限」是否与代码一致。
