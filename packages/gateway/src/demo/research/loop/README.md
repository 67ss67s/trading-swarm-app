# 研究会话与 loop

职责：将自然语言问题转成受控研究计划；执行只读数据工具与研究计算，保存不可变快照、图表/表格、结构化消息、步骤与可补发事件。只通过注入的 MarketData 读数据；策略验证复用现有 ResearchService，不提供交易所写入口。

- `store.ts`：六张新表、JSON Schema 校验、幂等、状态、快照去重和历史恢复。artifact 扩展采用 0029 的 generated 投影列，兼容旧七值 INSERT。
- `tools.ts` / `budget.ts`：工具目录、输入输出校验、超时/取消、缓存、预算与有限重试。
- `lexicon.ts`：指标/形态/数据指标词典（纯数据，中英文术语 → 真实存在的原语 / 指标表行 / data metric），近似与未支持如实标注。
- `concepts.ts`：概念解析 loop。抽概念 → 解析到原语目录 / 词典 / data adapter（钩子 `setDataConceptResolver`），状态 mapped / acquired / proxy / unmapped；获取子 loop `acquireConcept` 按 lexicon → brain → web 顺序取定义与实现方式（web 只有接口）。
- `modes.ts`：七种研究模式与计划模板。计划骨架由代码给，模型只填参数；`modeViolation` 是模式的结构不变量。
- `phrasing.ts`：原话里的周期 / 区间 / 交易频率说法（纯函数）：多周期「X 级别 trigger / Y 级别进出场」取执行周期并生成编译提示（方向门「MA N 主导」→ `htf_ma_state{htf,period,side}`，反向一侧 side=below 放 short_regime；「4h 背离」→ `macd_divergence{htf:"4h"}`，顶背离反向触发 `direction:"bearish"`；高周期原语从整段已收盘 K 线算，不受 5000 根视图上限约束），显式区间（「只要2026年」「2024-2025」「最近3个月」）解析成窗口且不拉长，「高频率交易」不算信号出现频率。
- `planner.ts`：概念解析 → 模式判定 → 模板填空；模型只填槽位，仍给整份计划时必须过模式不变量。参数引用 `$step_key.output_field` 必须声明依赖。
- `executor.ts`：拓扑调度，最多三步并发，检查点、事件、失败保留产物与最后的答案。
- `service.ts` / `routes.ts`：后台提问、澄清、取消和单请求会话恢复。
- `diagnose.ts` / `skills.ts` / `reflection.ts`:零模型回测诊断(diagnose/v3:每笔收益均值/中位数/截尾均值、核数、忠实度、同敞口持有、被拦原因、止损放宽、变体数);复盘 skill(仓库根 `skills/research-reflection`)按问题类型挑段注入 compose_answer 的系统提示;验证 / 横比回答由代码亮出复盘提示;模型复盘文本逐句核数字,对不上的句子剥掉。真模型基线:`npx jiti packages/gateway/scripts/research-reflection-eval.ts`。
- `backtest.ts`：price 快照 → 旧 from-market 导入 → study 预注册切段 → precheck → A-only 回测 → 同窗口持有比较。

测试（仓库根）：

```sh
npm run generate:check -w @trading-swarm/contracts
npm run build -w @trading-swarm/gateway
cd packages/gateway
npx vitest run test/demo/research --maxWorkers 4
```

测试的市场数据与分析结果全部注入 fixture，不调用网络。测试数据库使用 node:sqlite 内存库。刷新只读；启动恢复将非终态 inquiry 标记 incomplete/interrupted，不自动重跑。
