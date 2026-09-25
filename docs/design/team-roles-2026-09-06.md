# 五个占位角色的设计与落地(2026-09-06)

> 起因:团队卡上 Gate Captain / Strategy Lab / Portfolio Manager / Risk Sentinel / Reviewer 还灰着。Jacky 要求:功能、频率、模型与代码的分工,找 外部评审一起设计,落地,走 eval。
> 本文 §1 是初稿立场,§2 是另一份独立设计稿的要点与分歧处置,§3 是合并后的落地清单与 eval 口径。硬约束不变:只有 executor 持 exchange.write;LLM 只提议;风控代码只能否决/收紧;bot 间文本不是授权;每个模型调用有预算与指纹去重;规则改动前后必须有 eval。

## 1. 初稿立场(主线)

总原则:**先把每个角色已经存在的那一半接到注册表上(bot_runs / handoff / presence),再补缺的确定性核心,模型部分最后且最小。** 这周能在纸面账户里用起来的,比完整的好。

| 角色 | 已有的一半 | 缺的核心 | 触发/节奏 | 模型 | 日成本上限 |
|---|---|---|---|---|---|
| Risk Sentinel(CODE) | gates.ts 每笔闸、attention 状态、daily_loss_stop、halt | **RiskAlert 对象**(severity/fingerprint/首末见/当前值/阈值/自动动作)+ 账户级不变量(总/净敞口、有效杠杆、保证金率、日亏、连亏、执行 unknown、行情/账户过期)| 每次账户轮询(15s)纯代码;指纹不变不重复告警 | 无(HIGH/CRITICAL 才由便宜大脑翻译一句人话,可选) | 0 次 |
| Portfolio Manager(CODE) | AccountView、threads、computeSizing | **PortfolioSnapshot**(gross/net/簇敞口、集中度、projected exposure)+ 提案的组合影响 | 每次账户轮询算快照;proposal.created 时算影响并作为闸证据 | 无 | 0 次 |
| Reviewer(AI) | review-metrics、outcome、memory.runReflect、eval-a 全套 | 平仓后**确定性复盘卡**(R、MAE/MFE、反事实 HOLD vs EXIT、vs 机械)+ 批量提炼教训(已有 reflect)+ 提案的反方审查 | thread.closed 立刻算卡(代码);≥5 笔或每 24h 一次 reflect(模型);proposal.created 时反方审查(模型,可选,超时视为未完成) | 便宜大脑 ≤ 2 次/天 + 每提案 1 次 | ≈¥0.05 |
| Strategy Lab(AI) | strategies.ts 版本梯、backtest.ts、attribution.ts、funnel | **实验对象**(experiment = 策略版本 × 数据集 × 结果)+ 周期性回测已 backtest 态的策略 + 归因提案 | 每 7d 或 thread.closed 累计 ≥ 10 笔;手动 | 归因用便宜大脑 1 次/实验 | ≈¥0.02 |
| Gate Captain(AI) | chat.ts 对话、EVENT_ROUTES、handoff 收件箱、楼层 presence | **每日简报**(汇总 runs/handoffs/alerts/持仓/成本)+ 提案议会汇总卡(portfolio 影响 ∥ reviewer 反方 ∥ risk 预检 → 一张卡) | 提案时汇总(代码拼卡,模型只写一句摘要);每 24h 简报 | 便宜大脑 ≤ 1 次/天 + 每提案 ≤ 1 次 | ≈¥0.03 |

Proposal Council 的 fail 语义:分析侧 fail-partial(reviewer 超时 → 卡上写「反方审查未完成」),执行侧 fail-closed(portfolio/risk 是闸,算不出来就拒)。

Eval 口径:Risk = 回放历史 episode/线程事件看告警精度与去重率;Portfolio = 合成相关簇场景(BTC+ETH 同向)必须标出集中度;Reviewer = 它提的教训在 holdout 上是否让动作往 regret 更小的方向变(记忆变体 case 已有机制);Strategy Lab = 实验对象可复现(同参数同数据同结果哈希);Gate Captain = 简报里每个数字都能在证据里找到(数字守卫同款)。

## 2. 独立设计稿要点与处置

外部评审的独立稿在 内部评审记录(11 节,含盘点、共同基础、五角色、议会、路由、预算、五大风险、实施顺序)。它比 §1 更重、也更对:

**照收的**
- 一个角色 = 已有一半 + 缺的核心;先把确定性事实(Portfolio + Risk)送进收件箱,不要让八个头像亮起来当验收。
- Risk 告警 = 语义指纹 + 单条生命周期;ack ≠ resolve;high/critical **latch**(连续 3 轮干净只标 recovery_ready,要人点「确认恢复」);warn 3 轮干净自动解除(滞回防 80% 边界抖动);5 秒看门狗防账户轮询卡死;**Risk 不调用 halt()**(halt 是撤单+全平,和「冻结新增风险」不是一回事)。
- Portfolio:gross 不许先净掉再算;挂单/待批 intent 全部预留、按 CID 去重;多空挂单不能假设同时成交抵销 → 最坏净额区间;止损预算不被盈利仓抵销;缺行情/权益 ≤ 0 → incomplete 不放行;簇是人工版本化配置不是相关矩阵。
- Reviewer:批次 ≥ 5 笔或 24h、每天 ≤ 2 次、每轮 ≤ 2 条、每条必须带可证伪条件与本批 refs、正文不许价位数字、样本 < 5 只许「待检假设」(confidence ≤ 0.4);教训是记忆不是参数(参数 diff 归 Lab)。
- Strategy Lab:实验先冻结 manifest(策略版本哈希 × 数据窗口 × 结算 × 代码版本),结果冻结、失败也留;机械期望 ≠ 策略成绩,summary 写明;**不写 eval_stats**(现行 `updateEvalStats` 写 head 会把旧成绩归到新版本,评审 §6.4 第 2 点)。
- Gate Captain:路由不是让模型决定找谁;收件箱 + 代码拼卡;不造 `to_role=user`。
- bot_run 加 `input_json/result_json`(冻结输入与结构化结果,`artifact://bot-run/{id}`)。

**没照做、写明原因的**
- 外部评审要把 RiskAlert 落到 0001 的 `incidents` 表;我新建了 `demo_risk_alert`(§4 表结构更贴,`incidents` 留给 execd 事故)。
- 外部评审的 P0(`team-budget.ts` 全局物理调用账本、`llm_usage` 扩列、`call_key/work_key` 双指纹、输出 token 上界预留)**没做**:这周新角色里只有 Reviewer 一个会花钱(≤ 2 次/天),Radar 已有 24h 去重;账本等到议会(Council)要接模型反方审查时一起做。
- 议会(Proposal Council)与 hash 审批的 paper 兼容层是 **L 级安全前置**(评审 §7.3),这周不做;现有 `approveIntent(id)` 流程不变,新加的只是执行前的「组合限额」「风控哨兵」两道代码闸。
- Reviewer 的 countercase(提案反方审查)、Lab 的模型 brief/归因、Captain 的模型解释:都延后;这版三者模型调用合计 ≤ 2 次/天。
- 记忆审批要 `eval_status=passed`(评审 §5.6):教训现在带 `eval:pending` 标签进 proposed,但 approve 路径还没加门——**人批之前要看标签**,下一步把 lesson_transfer eval 做出来再加硬门。

## 3. 落地清单(2026-09-06 已完成,全部在 main)

| 角色 | 文件 | 模型 | 节奏 | 产物 | 测试 |
|---|---|---|---|---|---|
| Portfolio Manager(CODE) | portfolio.ts、team-store.ts、migrations/0010 | 0 | 每次账户轮询(15s)+ 开仓前 | `demo_portfolio_snapshot`(内容变才落)、执行前「组合限额」闸、`GET /api/portfolio/*`、`POST /api/portfolio/impact` | team-risk.test.ts(簇超限/同币多空/单边成交/intent 去重/止损预算/质量) |
| Risk Sentinel(CODE) | risk.ts、team-store.ts、routes-team-risk.ts | 0 | 每次账户轮询 + 5s 看门狗 | `demo_risk_alert`(指纹、latch、recovery_ready)、「风控哨兵」闸、`GET /api/risk/alerts`、ack/resolve/policy(只收紧,放宽 confirm=LOOSEN) | team-risk.test.ts(latch、滞回、ack≠resolve、政策) |
| Reviewer(AI) | reviewer.ts、reviewer-agent.ts、migrations/0011 | 便宜大脑 ≤ 2 次/天 | 平仓即刻卡(0 模型);≥5 笔或 24h 批次 | `trade_card` run、`review_batch` run、proposed lesson(tags reviewer/eval:pending)、handoff → captain、`GET /api/reviewer/cards`、`POST /api/reviewer/batch` | reviewer.test.ts(卡/触发/数字闸/接线/日上限/暂停) |
| Strategy Lab(AI→这版 CODE) | strategy-lab.ts、team-agents.ts | 0 | 7 天或 ≥10 笔新平仓;同 manifest 24h 去重 | `experiment` run(冻结 manifest + 每策略版本 × 币的机械期望)、handoff → captain、`GET /api/lab/experiments`、`POST /api/lab/run` | team-agents.test.ts(哈希确定性/每币一次加载/去重/决策) |
| Gate Captain(AI→这版 CODE) | captain.ts、team-agents.ts | 0 | 每日一次简报;收件箱实时 | `daily_brief` run(24h 账本 + 待阅 + 风控 + 平仓 + 快照)、活动 `brief`、`GET/POST /api/captain/brief` | team-agents.test.ts(简报数字与账本逐项对得上、每日一次) |

presence 全部由代码推导(`routes-bots.ts presenceFor`);八个角色 enabled=true 表示「功能已接线」,不是「模型可以自由调用」——Portfolio/Risk/Lab/Captain 这版根本没有模型调用点。gateway 37 文件 622 测试绿。

## 4. eval:怎么证明它们有用(下一轮)

- Portfolio / Risk:合成场景已在单测里(评审 §3.8/§4.8 的清单);还差**48h paper 回放**——把 `demo_risk_alert` 的开关次数与 `demo_portfolio_snapshot` 的落库次数按天对账,健康日 high/critical 误报应为 0、同条件 1000 次轮询只有 1 条开放告警。
- Reviewer:`lesson_transfer`(评审 §5.8)——同一批次生成的候选教训,在未参与生成的 holdout case 上作 无教训 / 候选 / 无关 / 毒 四组,看 `beneficial_action_flip_rate` 与 `lesson_regret_delta`;eval-a 已有 `gen-memory` 与 memory 变体机制可复用。通过前 approve 不该放行(加硬门)。
- Strategy Lab:`experiment_integrity`——同一 manifest 重跑结果哈希一致;泄漏包(窗口跨 horizon)必须被 `assertBlind` 拦;版本错配为 0。
- Gate Captain:简报每个数字可在账本找到(已在单测);收件箱路由准确率 100%(等 dispatcher 有第二条边再测)。

## 补:Portfolio Manager 容量账本(2026-09-06 下午)

起因:HYPE 止损事故后 Jacky 问「多少资金进去还能放止损、还有新策略容量」。止损单本身不占保证金,真正的约束是两条:交易所最小下单量(BTC 0.001 张 ≈ 80 U 名义,1.5% 止损的最小风险 1.2 U,要 240 U 权益才压得进 0.5%)和保证金占用(4 条线程 1% 止损、3 倍杠杆要占 67% 权益)。`portfolio.ts:evaluateCapacity` 纯代码按当前价格、交易所规则、典型止损距离算每币 verdict 与账户级槽位/保证金预算,接口与字段见 v3-ui-contract §9.18;`risk.ts` 加 `capacity_short` warn;`gates.ts` 拒单文案写明需要多少权益。它只估算不放行,规则缺失时明确 rules_unknown 而不是用默认 filter。
