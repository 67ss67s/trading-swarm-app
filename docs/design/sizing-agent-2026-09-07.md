# Agent 辅助仓位设计（2026-09-07）

## 边界与流程

Portfolio Manager 新增 cheap brain 意见阶段，数量仍由 `computeSizing` 决定。只作用于 demo PROPOSE（含对话提案），不改变 execd、审批和订单状态机，也不开放交易所工具。

`workflow.sizing_agent` 为 off / advise / apply，默认 advise，旧配置补默认。off 零调用；其他模式每个 PROPOSE 最多调用一次，10 秒硬超时，无修复调用。所有异常、非法字段、数字泄漏回退 multiplier=1、overshoot=false、split=1、applied=false。advise 记录而不采用。

代码构建证据：提案信心、代码策略 checklist（setup fit）、日线 regime 与 ATR%、账户权益、持仓及静态风险簇、该币容量行、当日 UTC 本通道已平仓实现盈亏、24h quote volume。缺失值明确 null。模型不接收自由拼接的历史模型理由。允许的控制数字也属于代码证据：multiplier 提供 0.25 至 2、步长 0.05 的菜单；split 为 1/2/3。所有输出数字（包括理由）必须在证据数字集合中，避免把价格子串误认为已见数字。schema 禁止额外字段，理由最多 40 Unicode 字符。

## 数量与硬闸

风险预算 = equity × workflow.risk_pct / 100 × multiplier。apply 才使用合法意见。min-lot overshoot 只允许最小可行手数风险达到调整后预算的 2 倍；通常容差仍为 1.05。允许 overshoot 时精确上取交易所最小手数，避免额外 2% 缓冲把本可行的小账户误拒。

max_notional_multiple 保持不变。新增政策 `max_quote_volume_pct` 默认 0.5（百分数），数量先按名义/流动性上限向下钳制，再检查最小量/最小名义是否可行。缺失或非法成交量拒单。portfolio gross/net/cluster/stop-budget 闸仍以最终整笔数量只拒不改；overshoot 和 split 均不能绕过。容量账本仍描述基准预算的典型止损，不把 agent 意见伪装成可用槽位；capacity_short 维持原告警语义。

split_entries 只是执行规划建议，落库但本期不实际拆单；任何拆单实现须另行保证逐腿最小量、累计预算、幂等与止损保护。

## 持久化、UI 与兼容

复用 demo JSON 持久化，在 intent.sizing.agent 与 episode.sizing.agent 写 `{multiplier,overshoot,split,reason,applied}`，同时记录 episode 的代码证据供复盘；失败保留明确回退理由。历史数据字段可缺失。GET intents 和 episode detail 透传，无新增经济契约或 DB 表迁移。正式六件套 JSON Schema 不受影响。

工作流增加“自动仓位：关 / 只建议 / 采用”。意图卡显示代码 sizing note 和 agent reason，并标识是否采用。

## 验证

数学测试覆盖倍率、最小手风险、2 倍边界、名义/流动性上限与组合上限；stub runtime 验证三模式、垃圾/越界/数字泄漏/超时回退及持久化。gateway 全量 vitest、tsc -b，webui tsc。按 AGENTS.md 由 tester 工作线复验并对抗 review；不调用付费模型、不提交、不重启 18800，不编辑用户列明的并行 UI 文件。

## 对抗审查后的补强

限价与 mark 的两个端点分别检查组合影响；数量的止损参考价使用 long 较高价 / short 较低价，名义上限用较高价，最小名义可行性用较低价，避免可成交限价低估风险。等待人批后发送前，使用固定批准数量复查风险预算、名义/流动性及组合硬上限，剔除本意图自身预留以免重复计算；此处只拒不改、不再调用仓位模型。

数字守卫扫描 JSON 解码后重新序列化的数据，防止 Unicode 转义拼出证据之外的数字。理由长度也在解码后检查。当日已实现盈亏指本通道的本地已平仓线程记录，不假装包含未导入的外部历史成交。
