# 自进化架构:记忆分域 + 受正则约束的 harness 进化(2026-09-23)

> 起因:Jacky 要给模型组件加「一定程度的 self-evolving / self-learning」。现状只有一个 universal 记忆,没有哪个 agent 有隔离记忆。本文是架构设计,落地派 Opus 5.5(effort 别太高)。参考论文 RRSI(arXiv 2609.24972,Google Cloud AI Research,2026-09-22)。
> 硬约束不变:模型只提议;风控代码只能否决/收紧;executor 唯一持 exchange.write;任何改行为的东西都要有 eval 前后对照。

## 0. 先说结论

1. **现在没有学习,只有记录。** 全部 17 条反馈回路(见 §1 盘点)里,能自动改行为的只有策略 Lab 的机械参数探针(draft→backtest→shadow→paper 自动晋升)。记忆、复盘教训、判断账本、归因、图违规,全部停在「写进表 / 显示给人看」。判断 prompt 是代码常量 `PROMPT_VERSION='demo-playbook-v11-formula'`,任何 agent 都改不了。
2. **记忆分域缺的不是「隔离」这个字段,是「谁写、谁读、谁为它的后果负责」。** `BotProfile.memory_scope` 是一段自由文本,`recall()` 三处调用点没有一处按角色过滤。加一个 `scope.role` 只是第一步。
3. **RRSI 给的真正启发不是「让 agent 改自己的 prompt」,而是「改之前先量噪声,改之后只准过噪声带且付得起成本的改动留下来」。** 交易系统的 evolve set 天然极小(18 笔平仓)、噪声极大,不做正则化的自进化 = 把最近三笔交易的巧合写进系统。所以本文的顺序是:**先把度量补齐(§2),再做 harness 组件化(§3),最后才是进化循环(§4)**。任何一步跳过,后面都是自欺。

## 1. 现状盘点(代码事实,2026-09-23)

记忆:`demo_memory` 单表,`scope={symbol,timeframe,regime}`,kind ∈ lesson/preference/fact/calibration,status proposed→active。写入方:平仓模板事实(system)、Reviewer 批次教训(agent,≤2 条/批,人批)、归因(agent,永不 apply)、用户 remember(直接 active)。读取方:判断前 `runtime.ts recallFor()`(≤5 条/600 字,作为 `E#[记忆]` 证据注入)、对话 recall 工具、UI 搜索。**没有 role / strategy_id 字段;没有「这条记忆被引用后的判断结果如何」的回写**(只有 use_count)。

反馈回路(自动 vs 人批,详表见子代理盘点,摘要):

| 回路 | 自动到哪一步 | 隔离域 |
|---|---|---|
| 平仓事实 → 记忆 | 提案自动,激活人批 | symbol/tf/regime |
| Reviewer 教训 → 记忆 | 提取自动(≤2/天),激活人批;**教训只能是记忆,不能改参数** | symbol/regime |
| 归因 → 记忆 + Lab 探针队列 | 提案自动;参数探针**自动验证并自动出 draft** | strategy_id/param |
| 判断账本 judgment_alpha | 记录自动;**没有任何代码读它来改任何东西** | by_strategy |
| Lab 自动驾驶 | draft→backtest→shadow→paper 全自动;paper→live_capped 人批 | strategy@version |
| 图违规 illegal_action | 每 episode 记;只有离线 eval 读 | 无 |
| 判断 prompt / 证据组装 / 触发器 | 代码常量,人改代码 | 无 |

结论:唯一的自动学习通路是「策略参数」,而 Jacky 观察到的问题(提前离场、盈亏比、扫描频率)全部在 **harness 层**(prompt 规则、触发节奏、持仓策略、证据字段),那一层 0 学习。

## 2. 第一层:度量(没有它,后面全是幻觉)

### 2.1 判断账本补「持仓期决策」

`demo_judgment_ledger`(09-12 上线)已经会对 review 期 HOLD/EXIT 算 hold_r / exit_now_r / regret,但上线时那批交易(09-03~09-12,9 次 EXIT、~200 次 HOLD)已经结束,至今 review 行只有 5 条,而且没按 holding_reason / 触发器分层。提前离场恰恰是最需要度量的行为,却几乎没被量过。

补齐(账本 v2):历史 episode 回填 + 对每一条持仓期判断(HOLD / EXIT / REDUCE)算三条腿:
- `R_plan`:按线程原计划(硬止损 / TP1 / horizon)走到底的 R;
- `R_chosen`:实际选择的结果(EXIT = 当时价平仓的 R;HOLD = 继续持有到下一决策点或计划终点);
- `R_trail`:机械吊灯线(比如 2.5×ATR)管理到底的 R。
派生:`regret_exit = R_plan − R_chosen`(EXIT 时),`regret_hold = max(0, R_chosen_if_exit − R_plan)`,按 `strategy_id × timeframe × trigger_kind × prompt_version` 分层聚合,写进 `LedgerSummary.by_decision`。这一步是纯代码,不加模型调用。

### 2.2 记忆的后果回写

`demo_memory_events` 加 `outcome` 事件:判断引用了记忆(evidence_refs 里有 `E#[记忆]`)→ 该 episode 结算后,把 `outcome_r` 与 `regret` 挂回记忆 id。聚合成 `memory_stats {cited_n, mean_r_when_cited, mean_regret_when_cited, mean_r_same_stratum_uncited}`。这是记忆级别的 credit assignment,也是 §4 剪枝的依据。

### 2.3 噪声带 δ 的校准

RRSI 的核心一步:**用不改任何东西的 H0 重复跑 k 次 evolve set,得到经验噪声带 δ**。交易里等价于:同一批冻结 case(eval-a 的 case + 研究台冻结数据集上的 B 臂重放),同 prompt 同模型跑 k=3 次,量 `judgment_alpha` / `regret_exit` 的方差。**没有 δ 之前,禁止任何自动接受。** 这个数字要存进 `harness_eval_baseline` 表,和每次评估一起存。

**Codex 复审的保留意见(照收)**:同一 case 重跑 k 次只量到模型采样噪声,量不到市场抽样、regime、策略选择和时间相关性;18 笔交易的有效独立簇远小于行数;触发节奏一改,旧 case 的决策分布也变了,离线评分不再是可靠反事实。所以 δ 之前还有更前置的一步:**定义 estimand、独立簇(按线程/候选机会聚类)、as-of 数据、walk-forward / evolve / pristine-holdout 三分法**,再建生产 harness 的配对回放。RRSI 论文自己也把「held-out/OOD 迁移」当核心证据,只在 evolve set 上超过噪声不算数。

### 2.4 每决策成本

`llm_usage` 已经有 token/cost,但没和 episode 对齐。加 `episode_id` 关联,得到「每笔交易的判断成本」和「每次 harness 变更的 ΔC」。

## 3. 第二层:harness 组件化(可版本、可指纹、可回滚)

RRSI 的组件词表 K = {prompt, control_flow, config, output_plumbing, context_mgmt, tool, skill, memory, subagent}。映射到本系统:

| K | 本系统对应物 | 现在在哪 | 改成什么 |
|---|---|---|---|
| prompt | 判断 system 规则(v11)、Reviewer/sizing prompt | context.ts / reviewer.ts / sizing-agent.ts 常量 | `harness_component(kind='prompt', id='judge.rules.exit', version, hash, body)` 落库;代码常量只是 seed |
| control_flow | 触发器种类与节奏、持仓复查节奏、min hold、指纹去重窗口 | runtime.ts / fingerprint.ts / holding-policy.ts 常量 | `HoldingPolicyParams` / `TriggerPolicy` 作为带版本的配置对象 |
| config | R 下限、ATR 门槛、止损/止盈规则、日判断上限 | review-metrics.ts / workflow | 同上,统一进 `harness_version` |
| context_mgmt | 证据字段清单(E1..E12)、记忆注入预算 | context.ts | `EvidencePlan`(evidence-plan.ts 已有雏形)按策略/角色可变 |
| memory | 记忆分域与读写规则 | memory.ts | §5 |
| skill | 策略 playbook 文本、策略 IR | workflow.playbook_text / research IR | 策略对象(见 strategy-apply-spec) |
| subagent | 角色(radar/reviewer/sizing/council) | bots.ts | 每角色一个 `harness_component` 组 |

**`harness_version`** = 上述组件版本的集合 + 内容哈希。每个 episode 记 `harness_version_id`(现在只记 `prompt_version`)。账本按 harness_version 分层 → 才能说「这次改动让 regret_exit 从 0.8R 降到 0.3R」。

**编辑记录 `harness_edit`**(RRSI 的 history L_t):`{id, round, component, hypothesis, diff, delta_score, delta_cost, accepted, evaluated_on(baseline_id)}`。被否掉的假设也留着,proposer 下次要看到「这条已经试过、没用」。

## 4. 第三层:进化循环(受正则约束)

一轮 = 提案 → 筛查 → 评估 → 接受/拒绝 → 部署。全部离线、全部在冻结数据上,**线上只跑已接受的 harness_version**。

### 4.1 提案侧(Proposer,便宜大脑或 opus,每周 ≤1 轮)

输入:账本分层(§2.1)里最差的 stratum、`harness_edit` 历史、剪枝目标 B_t、当前轮编辑预算 b_t。
- **编辑预算退火**:第 1 轮允许 3 条原子改动捆绑,之后按余弦退到 1。原子改动 = 只动一个组件(一条 prompt 规则 / 一个触发节奏参数 / 一个证据字段 / 一条记忆写入规则)。
- **证据感知**:prompt 里给它 L_t 的摘要:「组件 X 最近 4 轮最好增益 ≤0 → 剪枝候选」「假设 h 已被否」。
- **结构化探索**:连续 3 轮增益 ≤ δ 判 stall,预留 1 个提案槽给从没动过的组件(比如一直改 prompt 就强制去动 control_flow)。
- 输出:候选 harness_version(diff + 组件 + 假设标签)。

### 4.2 筛查侧(Critic,零成本先过)

- **泄漏筛查**:改动里出现具体 symbol / 日期 / 价位 / 某一笔交易 id → 拒(除非该组件本身就是 symbol 域记忆)。对应现有 `PRICE_LIKE` 正则与 `memory_number_leak`,推广到所有组件。
- **惰性机器筛查**:新增了证据字段/工具但没有任何规则引用它 → 拒。
- **不变量筛查**:模型不能放宽风控、不能碰 exchange.write、不能改 executor 边界 → 静态检查。

### 4.3 评估侧(Evaluator,冻结数据,零线上风险)

评估环境就是**研究台的 B/C 臂重放引擎**(research/engine.ts + 冻结 dataset):把候选 harness 的 prompt/持仓策略/触发节奏换进去,在同一批冻结数据上跑 k 次,产出 `S = f(judgment_alpha, regret_exit, PROPOSE 质量)` 与 `C = 每笔判断 token`。这就是研究台与 swarm 最有价值的一条联动:**研究台不只回测策略,也回测 harness**。

### 4.4 接受侧(Selector,非补偿性)

- 噪声地板:`S(H') ≥ S* − δ`;
- 成本规则:`ΔS > δ` 时要求 `ΔC ≤ β0 + β1·ΔS`(β0=10% token 宽容,β1 按「每 +0.1R 允许 +25% token」起步);`ΔS ≤ δ` 时用带内规则:只有降成本或触到从没动过的结构组件才准进;
- 域守卫:`evidence_valid` / `schema_valid` 下降 > 3 个点直接拒(对应 RRSI 的 valid-output guard);**不用 PROPOSE 率做守卫**——更少但更好的提案可能恰是改进(Codex);评分按「每个候选机会」配对,skip 记 0R;
- 剪枝:连续 n_prune=4 轮无正增益的组件,下一轮提案必须包含删除它的候选(证据字段没人引用、触发器 14 天 0 次 PROPOSE、记忆 cited 后 regret 更高 → 全是剪枝对象)。

### 4.5 部署侧(和策略一样走状态机)

`harness_version: candidate → evaluated → shadow(线上 B 臂并行只记不下单) → active(人确认) → retired`。线上 shadow 就是现有 `demo_shadow_thread` 机制,不需要新造。回滚 = 把 active 指回上一版。

### 4.6 现实的节奏与成本

- 评估一轮 ≈ 冻结 case 数 × k × 候选数 次便宜模型调用(GLM ≈ ¥0.006/次)。200 case × 3 × 3 候选 ≈ 1800 次 ≈ ¥11/轮。每周一轮可接受。**超过 500 次调用先报价再跑**(记忆里的规矩)。
- 前 4 轮预期主要是「删东西」(剪枝),不是加东西;这是对的(RRSI 的结论:正则化后的 harness 比未正则的少 30% token)。

## 5. 记忆分域(具体设计)

### 5.1 三种记忆,三种生命周期

| 类型 | 内容 | 谁写 | 谁读 | 怎么变成行为 |
|---|---|---|---|---|
| 情景(episodic) | 平仓事实、复盘卡 | system 模板 | Reviewer、策略假设 | 只作为教训的原料,**不进判断 prompt** |
| 语义(semantic)= 教训 | 「X 情形下 Y 通常失败」 | Reviewer(人批) | 判断(按域召回)、Radar | 作为证据注入(现状);被引用后回写后果(§2.2) |
| 程序(procedural)= 规则/参数 | 持仓策略参数、prompt 规则、触发节奏 | **只有进化循环(§4)**能改;Reviewer 只能提「假设」 | 运行时 | 通过 harness_version 生效 |

现状的 `calibration` kind 属于第三类却混在记忆表里且没接任何阈值,应迁到 harness 组件。

### 5.2 域(namespace)与读写矩阵

`scope` 扩为 `{layer: 'global'|'role'|'strategy'|'symbol'|'thread', role?, strategy_id?, symbol?, timeframe?, regime?}`。**Codex 复审(照收,P0-2 落地后下一版改)**:`layer` 把「谁能读」(audience ACL)和「适用于什么」(applicability:strategy × symbol × regime 可以同时成立)混成一个互斥枚举;应拆成 ACL 字段 + 适用维度字段。另两条:用户在对话里口述的记忆直接 active 且可落 global,是一个持久化 prompt-injection 面,global 层的用户写入也该过一次确认;「被引用后的 R/regret」不是因果归因(被召回的记忆本来就在更难的情景出现),只能做剪枝候选标记,且要配同层未引用基线。

| 角色 | 可读 | 可写(提案) |
|---|---|---|
| thread_manager(判断) | global + strategy(当前线程策略)+ symbol(当前币)| 无(判断过程不写记忆,现状规则保持) |
| reviewer | 全部(它需要跨域看) | role:reviewer(自己的复盘方法教训)、strategy、symbol、global |
| radar | global + symbol(筛选类教训,tag=screen) | role:radar |
| portfolio/sizing | role:portfolio(calibration 只读)| 无 |
| strategy_lab / research agent | strategy + global | strategy(研究日志、否掉的假设) |
| gate_captain / 对话 | 全部 | 用户口述 → global 或指定域 |

`recall()` 加 `reader_role` 参数,按上表过滤;`propose()` 校验 `proposed_by_role` 有权写该域。`BotProfile.memory_scope` 从自由文本改成结构化 `{read: [...], write: [...]}`,`validateRoleBoundaries` 启动时校验。

### 5.3 记忆预算与剪枝

每域召回上限单独设(strategy 域 2 条、symbol 域 2 条、global 1 条),避免一条 global 教训永远占满 5 个槽。`memory_stats.mean_regret_when_cited` 比同层未引用高 0.3R 且 cited_n ≥ 8 → 自动 `superseded` 候选(人批一键)。

### 5.4 补充:Jacky 问「还能补充啥」

- **置信度校准**:模型报 0.72 的 HOLD 实际后验 R 是多少?按角色 × 动作做校准表,不校准的置信度不该进闸门。
- **触发器产出率**:14 天 6821 次 `event` 触发、0 次 PROPOSE,这是最该被剪的组件,而它没有任何指标。
- **证据字段引用率**:E1..E12 哪些从没被 `evidence_refs` 引用过 → 剪枝 → 省 token。
- **角色级 self-eval**:Reviewer 提的教训在 holdout 上 `lesson_regret_delta` 是否为负(团队角色文档 §4 早已写了 `lesson_transfer`,一直没做)。
- **策略级「什么时候不要叫模型」**:C 臂 alpha ≤ 0 的策略直接 mechanical 模式,这本身就是进化(减法)。

## 6. 落地顺序(给 Opus 5.5 的工单边界)

P0(本周,纯代码,零模型调用,先做):
1. 判断账本 v2:持仓期 HOLD/EXIT 反事实三条腿 + `regret_exit`,按 strategy×tf×trigger×prompt_version 分层(judgment-ledger.ts、runtime.ts 记录点、routes-judgment.ts 展示)。
2. 记忆分域:`scope.layer/role/strategy_id` 字段 + 迁移 + `recall(reader_role)` 过滤 + `propose` 写权校验 + `memory_stats` 后果回写(memory.ts、types.ts、migration、runtime.ts 三个调用点)。
3. `episode.harness_version_id`:先把 {prompt_version, holding_policy_version, trigger_policy_version} 打成哈希记上,账本按它分层。

P1(下周):harness_component / harness_edit 表与 seed;评估器接研究台 B 臂;δ 校准脚本。
P2:Proposer + Critic + Selector 的第一轮(目标只做剪枝)——**Codex 判定现阶段是幻想,不启动**;样本、holdout 与因果识别都不够,先把 P0/P1 的度量与 estimand 做出来。

不做:让任何 agent 在线改 prompt;让记忆改数字;跳过 δ 直接接受;按 memory cited regret 自动剪枝。
