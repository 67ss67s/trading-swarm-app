# 策略规范(Strategy Spec v1,2026-09-22)

每个会**产出或修改策略**的 agent 都遵守同一份规范。代码在 `packages/gateway/src/demo/research/strategy-spec.ts`,这份文档是人读版;两者不一致以代码为准。

## 为什么

第三轮之前,成本下限、最小盈亏比、ATR 尺度这些数字只喂给了 compile 这一个 agent。B 臂代理出 proposal 时完全不知道成本,止损事后被 order-gate 放宽到下限(收尾轮 `a5304c87`:3 笔止损全部从 1.6% 放宽到 2.40%);C 臂和研究对话代理没有任何策略规范。「模型在出策略时就把止盈止损放到合理点位」只在编译期成立。规范把设计期约束做成一份代码,四个 agent 共用,回测与实盘同一份 order-gate 兜底。

## 通用条款(按本数据集实例化,数字来自 `compileConstraints`)

| 条款 | 内容 | 谁检查 |
|---|---|---|
| 1 成本 | 止损距离 ≥ 成本下限 `min_stop_cost_multiple × 往返成本`(SOL 1h 默认:0.30% × 8 = 2.40%);被放宽到下限的止损标 `cost_floor`,不是策略的功劳 | order-gate(执行期)、`checkProposalSpec`(B 臂)、precheck `stop_fit_rate` |
| 2 盈亏比 | 止盈必须有独立来源(`structure_target` 或用户要求的 `fixed_r_target`),放置后 RR ≥ `min_rr`(默认 1.5);结构没空间的位置策略主动放弃 | `checkIRSpec`(target_source_missing / fixed_r_below_min_rr)、order-gate `min_rr` |
| 3 尺度 | ATR 止损倍数 ≥ `stop_floor_pct / ATR(14) 中位`(SOL 1h ≈ 2.9);低于它等于用成本级别的止损 | `checkIRSpec`(atr_multiple_below_floor;实测放宽比例 > 50% 直接 block `stop_mostly_widened`) |
| 4 方向 | 优先 `htf_structure_regime` 让已收盘高周期结构决定方向 | `checkIRSpec`(regime_missing,warn) |
| 5 样本 | < 30 个候选/交易不宣称策略有效;零交易 ≠ 高胜率;completed 只表示算完了 | precheck `min_trades`、前端答案层文案 |
| 6 描述 | description 写预期持有期和每 1000 根信号频率量级;未测量就写明是待验证假设 | `checkIRSpec`(description_* ,warn) |

`block` = 这条策略在本数据集上大概率只是在跑成本,不允许发起实验(研究代理的 `policy.draft` / `experiments.run_candidate` 直接拒绝 `strategy_spec_violation:<codes>`;前端「用这条策略新建实验」禁用)。`warn` 只记录。

## 各 agent 的义务

**compile(自然语言 → IR)**:system prompt 收到 `specText(constraints,'compile')`;止损优先结构位,用 `atr_stop` 时倍数按第 3 条;`fixed_r_target.r ≥ min_rr`;追踪出场不替代止盈;不能映射的语义写进 `unmapped`。编译结果返回 `spec`(违规清单 + 规范原文)和 `rules`(可读规则卡)。

**B 臂(代理自由判断)**:system prompt 追加 `specText(…,'b_agent')`。PROPOSE 时 `stop_price` 距收盘 ≥ 成本下限,`take_profit_price` 必须给且 RR ≥ min_rr,止损优先结构位、止盈放上方阻力块下沿;达不到就 NO_TRADE 并说明是「结构没空间」还是「止损会被放宽」。每条 proposal 的原始止损/止盈过 `checkProposalSpec`,结果记进 `decision.spec_violations`(codes:`proposal_stop_below_cost_floor` / `proposal_stop_below_2x_cost` / `proposal_no_target` / `proposal_rr_below_min` / `proposal_stop_side` / `proposal_target_side`)。放置与拦截仍由 order-gate 做,规范只记录「代理自己有没有做对」。

**C 臂(follow/skip)**:prompt 追加 `specText(…,'c_filter')`:候选 `fit.stop_source=cost_floor`、`fit.rr < min_rr`、target 为空应 skip;理由只谈策略规则与结构位置。

**研究对话代理(沙箱 loop)**:prompt 追加 `specText(…,'research_agent')`(按当前选中 run 的数据集实例化,没选 run 用默认成本):起草候选前先 `strategies.compile` 带 `dataset_id` 读 `spec.violations`;有 block 不得发起(后端同时强制);一轮最多两个经济参数;不按 holdout 调参;报告按「观察 → 假设 → 验证」三段,样本不足只写观察。

## 兼容

- 新建 run 由 `store.create` 自动盖 `request.spec_version='strategy-spec/v1'`;旧 manifest 没有这个字段,B/C 提示词与记录时一致、决策行不加 `spec_violations`,重放哈希不变(`strategy-spec.test.ts` 有对照断言)。
- 同日修复:`ResearchMetrics.expectancy_pct` / `per_trade_return_pct.*` / `trade_return_histogram.bins` 改为契约口径的小数(之前后端乘了 100,前端再乘 100 显示成「每笔期望 -143.15%」)。旧 run 存的结果仍是百分数,前端按 `spec_version` 缺失判旧口径除以 100。

## 已验证(2026-09-22,18811 真数据)

对交接包里那条 SOL 1h 策略(收盘突破 10 根 + 放量 1.1×,2 ATR 止损,2R 止盈)带 `dataset_id` 编译:`spec.ok=false`,`block stop_mostly_widened`(82% 候选止损会被放宽到 2.40%),`warn atr_multiple_below_floor`(2 < 2.9)、`regime_missing`、`description_missing_signal_frequency`。这正是收尾轮跑出 −4.25% 的那条策略,现在在设计期就被拦下并给出改法。
