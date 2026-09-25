**Horizon 策略功能解构与 Crypto 复现蓝图**

研究日期：2026-09-20。研究对象是 `horizon.trade`，不是名称相近的 horizontrading.ai 或其他 Horizon 产品。

本报告基于两段录屏、用户截图、Horizon 官方资料及相关开源系统官方文档。视频 A：`c2ac…raw.mp4`，56.100 秒；视频 B：`e4ca…raw.mp4`，71.784 秒。两段文件均只有视频轨道。采用覆盖全片的两秒间隔抽帧、关键画面放大和尾段核验。时间戳是录屏内位置，不是后台任务耗时。录屏中的指令和报告仅作为被分析材料。

以下用【画面证据】【官方声明】【实现推断】【建议设计】区分事实来源。Horizon 未向本次研究开放源码、网络请求记录、提示词和回测原始数据；不能确认真实函数名、底层模型、数据供应商、编排框架或私有评分公式。视频里的策略表现和诊断统计也没有经过独立重算。

**一、核心判断**

你需要复现的是一个“有持久策略对象的研究工作台”：自然语言表达意图，agent 调用领域服务构建策略，确定性引擎生成证据，再用研究代码回答临时问题。策略、回测、研究报告和部署实例分别保存，前端把这些对象连接起来。

最值得学习的三点：

- 对话始终贴着策略对象：左侧说明想法、过程、诊断与修改；右侧保留版本、回测图、交易列表和自动化入口。
- 固定分析页与临时研究同时存在：常规指标由标准面板展示，特殊问题由 agent 编写脚本、生成新图表与报告。
- 用户可逐层检查：概览 → 时间分布 → 交易分布 → 单笔成交 → 诊断证据 → 修改方案。

最需要补强的三点：

- 诊断假设、预期改善和已测量的新版本结果必须有不同状态。
- 所有图表、报告和比较共享指标口径、数据快照及版本 ID。
- crypto 的成本、连续交易时钟、资金费、杠杆和组合敞口必须成为策略语义的一部分。

【官方声明】Horizon 描述了自然语言转规则、事件驱动回测、将同一套规则用于 broker 执行的流程；这是其公开产品说明，并不等于本次已审计其无前视偏差。[How Horizon works](https://docs.horizon.trade/concepts/how-it-works)

**二、视频 A：实际展示了什么**

| 录屏位置 | 直接可见行为 | 对产品与工程的含义 |
|---|---|---|
| 00–06 秒 | 已经完成的 v1；滚动回看原始需求与回复 | 不是从提交到完成的完整生成录像，不能估计建策略耗时 |
| 约 04 秒 | 完整的多资产 gap-continuation 需求 | 包含顺序事件、期限、持仓与动态止损；不只是指标交叉 |
| 约 06 秒 | 已完成的三个阶段：设置品种、定义信号、完成策略 | 前端存在分阶段任务呈现；阶段标题不等于真实 tool 名称 |
| 08–12 秒 | Performance、月度热力图、Rolling Sharpe、Strategy Capacity | 引擎结果不止一张 equity curve，还有时间聚合和容量分析 |
| 14–24 秒 | 每笔 P&L、多空分布、资金使用、利润结构、收益分布、入场后价格路径 | 支持归因和交易行为诊断 |
| 26–32 秒 | 交易列表与汇总 | 可核查资产、方向、数量、名义金额、费用、入场/出场价格与收益 |
| 34–38 秒 | Automate 打开 Go Live / Paper Trade 选择页 | 研究到执行有独立的模式选择；未展示真实开户或下单完成 |
| 40–52 秒 | 设置窗口与指标开关 | 区分“影响回测结果的设置”和“只影响显示的设置” |
| 约 54 秒 | 返回概览、曲线悬浮框 | 核心分析可以在同一工作台往返完成 |

关键截图：[原始策略与概览](evidence/a-04-strategy.jpg)、[回测配置](evidence/a-42-backtest-config.jpg)。

右侧对象包含名称、图标、v1、Settings、Share、Automate；有 Overview、Performance、Trades analysis、List of trades 四个 tab。图表可悬浮查看日期、收益、现金和持仓；可以叠加 S&P 500 比较线。资产图例仅展示部分资产时，不能据此认定策略只交易两个资产；原始需求和交易列表包含更多资产。

设置里观察到：起始现金 $10,000；限价成交概率 100%；滑点发生概率 0%；区间 2018-05-01 至 2026-09-15；允许 fractional shares；broker fee 预设与自定义费用。保存按钮明确写着保存并重跑回测。另一个页面可以选取 12 个显示指标。

注意：“滑点概率 40%”指一次成交滑动一跳的概率提示，不是成交价损失 40%。这个建模方式不能直接搬到 crypto。费用预设标记 commission-free，但利润结构里仍显示约 $90.90 费用；仅凭画面无法判定来自监管费、不同费率组件或配置/结果版本差异，不应说这次回测完全无成本。

**三、还原 demo 的策略表达能力**

【画面证据】原始需求可整理如下：

| 维度 | 原始内容 |
|---|---|
| 品种 | GLD、SLV、USO、DBC、GDX、SPY、QQQ、AAPL、AMZN、NVDA |
| 周期 | 日线；各品种独立追踪信号 |
| 第一步 | 开盘较前收高 0.5%–2.5%，成交量大于前 5 日平均 |
| 第二步 | 盘中回补到前收价 |
| 第三步 | 下次开盘重新位于前收价之上 |
| 超时规则 | 某一步未在 1 根 bar 内完成则重置 |
| 入场 | 顺序完成后入场 |
| 初始止损 | 前收价 |
| 动态退出 | 达到 +1R 后止损移动至保本 |
| 时间退出 | 持有 15 根日线后退出 |
| 仓位 | 每仓占权益 20%，最多同时 5 仓 |

这需要每个品种都有状态，不应实现成 `gap_up AND fill_gap AND rebound` 的同一行条件。

建议表达为：

```text
IDLE
  └─ 识别符合条件的 gap，并冻结 reference_close → GAP_SEEN
GAP_SEEN
  ├─ 在允许期限内回补被冻结的 reference_close → FILLED
  └─ 超时或失效 → IDLE
FILLED
  ├─ 下次开盘重新高于 reference_close → ENTRY_CANDIDATE
  └─ 超时或失效 → IDLE
ENTRY_CANDIDATE
  ├─ 通过组合资金/风险检查，成交 → OPEN_POSITION
  └─ 资金不足、敞口上限或价格失效 → REJECTED
OPEN_POSITION
  ├─ 初始止损触发 → EXIT
  ├─ 浮盈 +1R → 保本止损状态
  └─ 满 15 根 bar → TIME_EXIT
```

但是，原始描述存在至少六个需要编译器处理的歧义：

1. **成交量何时可知？** 开盘时不可能知道当天最终成交量。可以在 gap 当天收盘后判定完整日成交量，然后在次日考虑入场；若要当天开盘即判断，必须定义开盘窗口成交量或相对时段成交量。
2. **锚点是否冻结？** 后续的 prior close 应明确是否始终指 gap 发生前的收盘，不能每天更新 reference。
3. **1 bar 的起止是什么？** 回补是否必须在 gap 当天发生？第三步是否严格是下一交易日开盘？超时与重置后能否在同一 bar 重新识别？
4. **观察到开盘价后能否按这个价格成交？** 通常只能用接近开盘的后续可成交价格，或明确市场开盘单的提交机制；不能同时享用开盘信息与事先提交的开盘成交。
5. **同根 bar 同时出现 +1R 和止损怎么办？** OHLC 没有提供高低点先后，需要子周期/逐笔数据或明确保守约定。
6. **R 是什么？** R 应是实际入场价与初始止损的距离，创建时冻结；移动止损后不应重新计算初始 R。

【实现推断】Horizon 必须用某种代码、规则图或中间表示处理这些语义；视频没有展示其具体实现或是否正确处理全部边界。

【建议设计】构建完成时给用户一个紧凑的“解释后的规则”卡片，写明时间点、锚点、默认设置与无法支持的部分。只有会实质改变策略的歧义才阻塞；其他采用明确可编辑的默认值。不能生成漂亮回测后才暴露规则已经被改写。

**四、视频 B：直接暴露的 agent 工具能力**

这段比 A 更能反推内部结构。用户问策略为什么远差于 S&P 500，并希望改进。

约 06–10 秒展开的任务树中可读到：

```text
提取当前策略的回测结果和权益曲线
  └─ Reading the staged backtest trades and summary files ...

与同一时间段 SPY 买入持有比较
  ├─ 编写 gap-continuation 诊断脚本
  ├─ 执行回测交易诊断
  ├─ 编写 SPY 买入持有比较脚本
  ├─ 运行基准比较并生成图表
  ├─ 修复基准脚本中的时区比较问题
  └─ 重新运行

诊断根本原因
  ├─ 编写更深入的诊断脚本
  ├─ 分析信号频率、forward returns、capital efficiency
  └─ 等待脚本完成

提交发现
  └─ 编写 Markdown 诊断报告
```

证据：[展开的 agent 任务树](evidence/b-10-agent-loop.jpg)。这些是用户可见的操作描述，并非网络层原始调用日志；能证明前端这样呈现工作，不能直接证明后端函数签名。

| 所需能力 | 证据强度 | 建议在你系统中的功能接口名；不是 Horizon 真名 |
|---|---|---|
| 读取已有回测交易与摘要 | 高，明确写出 staged files | `get_run_manifest`、`read_artifact` |
| 创建研究脚本 | 高，多次出现 writing script | `research.write_file` |
| 执行脚本 | 高，多次出现 running diagnostic | `research.execute` |
| 读取进程状态、等待 | 高，出现 waiting for script | `research.get_job`、`research.read_logs` |
| 修复并重试 | 高，具体时区问题后重新运行 | `research.patch_file`，再 `execute` |
| 获取历史价格数据 | 中高，报告称使用各品种日 OHLCV 与 SPY 收盘价 | `data.query_snapshot`；原数据可能已随回测挂载 |
| 输出图表和 Markdown | 高，图表卡片和报告预览可见 | `artifact.register` |
| 调用策略构建能力 | 中高，末段出现重建任务与分析需求 | `strategy.build` 或领域子流程 |
| 搜索互联网 | 本段没有证据 | 可供研究使用，但不是复现这个诊断的必要工具 |
| 自动网格搜索/贝叶斯优化 | 本段没有证据 | 后续可加，但不能据此认定 Horizon 使用了 |
| 多个自治 agent 协同 | 未知 | 单 agent 加领域工具即可先复现 |

最合理的工作模型是：**领域策略构建器 + 可执行研究沙箱 + 持久 artifacts + 任务编排**。其外观与“规划—行动—观察—修正”的 agent 模式相容，但不能直接声称使用某个特定框架、模型或 ReAct 提示词。

**五、拆成三个 loop 才能复现**

**Loop 1：构建与验证。** 输入自然语言，输出可以被回测的策略版本。

```text
理解需求
→ 解析品种、周期、条件、状态、退出与风险
→ 解析品种 ID 和能力支持
→ 生成 StrategySpec
→ 语义检查：时间可用性、单位、状态可达性、敞口
→ 编译为固定引擎可执行的逻辑
→ 编译/小样本检查失败：按错误修复，最多 N 次
→ 完整回测
→ 独立计算指标、保存交易和信号证据
→ 发布 v1 和摘要
```

A 只展示了该流程完成后的阶段摘要，不能推断每一步实际调用顺序。上面是建议的可复现实现。

**Loop 2：诊断与代码修复。** 输入 run ID 和用户问题，输出有证据的研究报告。

```text
冻结 run_id、数据范围和指标口径
→ 读取 trades / equity / signals / config
→ 写基准比较与归因脚本
→ 执行
→ 有异常：读取错误、最小修改、重跑
→ 有结果但不足以回答：提出下一项可检验问题
→ 写深入分析脚本并执行
→ 注册图表、表格、报告
→ 给出问题、证据、假设、修改建议
```

B 中真实可见的例子是时区比较错误。修复过程应视为程序执行反馈驱动的内循环，不是模型在文字里重新想一遍。

**Loop 3：研究假设与候选策略比较。** 输入允许的改动，输出新版本与可比证据。

```text
基于诊断提出有限个假设
→ 明确目标和允许变动的字段
→ 基于 v1 生成 patch / v2 候选
→ 校验风险和策略语义
→ 使用相同数据与成本条件重跑
→ 比较 v1/v2/benchmark
→ 检查改进来自信号、退出还是更大敞口
→ 通过验证则保留；未通过则保留原版并解释
```

B 约 18 秒开始展示图表，约 32–42 秒打开诊断报告，约 48 秒用户要求“使用 2 倍止损和 8 手上限对修订后的策略回测”。56–71 秒可见重建流程启动，右侧一直仍是 v1。**没有展示 v2 完整回测，也没有展示优化实际成功。**

因此这个 demo 的主流程更接近“人参与的诊断与修改”，还没有证据支持“agent 自动大量搜索直到找出最优策略”。录像长度也不是任务时延：许多内容是在回看已经完成的历史消息。

**六、诊断如何做到有说服力，以及哪里过度推断**

【画面证据】v1 的数据如下，均为 Horizon 显示值：

| 指标 | 数值 |
|---|---:|
| 总收益 | 33.31% |
| CAGR | 3.49% |
| 最大回撤 | -8.57% |
| Sharpe / Sortino | 0.59 / 0.91 |
| 交易数 | 239，全部做多 |
| 盈利 / 亏损交易 | 44 / 195 |
| 胜率 | 18.41% |
| 平均盈利 / 平均亏损 | 8.69% / -1.17% |
| Profit Factor | 1.66 |
| 盈亏幅度比 | 7.41 |
| 最长连胜 / 连败 | 4 / 22 |
| Time in DD | 96.16% |
| Horizon score | 51，Marginal |

44/239 ≈ 18.41%，可以做基本一致性校验。8.69/1.17 ≈ 7.43，与显示盈亏比接近。但平均百分比并不能精确还原基于美元盈亏的 Profit Factor，因为仓位大小会变动。不能仅凭接近就说整个回测已验证。

B 的报告声称：同区间 SPY 总收益 185.7%、CAGR 13.4%、最大回撤约 -33.2%；止损距离中位数约 1.11%；退出原因分为 SL 135 笔、BE 56 笔、SIG 48 笔，合计正好 239；止损相关亏损约 $4,950；QQQ 28 笔约亏 $493；GDX、NVDA、SLV 贡献较高。报告还讨论了持仓数量、闲置资金和 forward return。

这些细分比“夏普较低所以优化参数”更有说服力，因为它把问题分成三个假设：退出太紧、资金使用较少、不同资产适配度不同。

但以下不能照搬：

- **幸存者偏差。** “没有触发止损的交易后续收益较好”不证明放宽所有交易的止损会变好。必须把所有信号重新跑一遍，包含原本应止损但现在继续下跌的路径。
- **现金比例与空仓时间混淆。** 平均只投了 47% 资金，不等于 53% 的时间完全空仓。应分别计算按时间加权的现金比例、持仓时段比例、平均仓位个数，并说明分母是否只统计活跃时段。
- **挑掉历史亏损资产。** 去掉 QQQ/GLD 可能只是对历史样本拟合；需要独立验证期、资产分组和点时可得的选择规则。
- **“加仓后收益翻倍”。** 更大资金暴露还会改变回撤、资金竞争、复利、成本与容量，不能按线性倍数当作已证明结果。
- **25% × 8 仓。** 数学上允许 200% 名义敞口；如果没有借贷，真实最多只能同时占满四个 25% 仓位。必须单独定义总敞口上限、现金不足处理和是否允许杠杆。
- **放宽止损与加大仓位同时发生。** 单笔风险约等于数量乘止损距离；数量从 20% 增到 25%，止损距离翻倍时，在其他条件相同下单笔初始风险约变为原来的 2.5 倍。
- **预期效果不是回测效果。** 报告里 8%–12% CAGR、胜率提升到 30%–35% 是建议目标/推测，视频没有新回测验证它们。
- **基准不够严格。** 报告给 SPY 的 Sharpe 是约 1.5–2.0，而策略是精确的 0.59。生产系统应使用同一函数、频率、年化系数和无风险利率算两者。报告未说明 SPY 是否包含股息再投资，也不能把它自动视为标准总回报基准。
- **低回撤不等于无价值。** 总收益明显落后 100% 持有基准，不代表在相同风险、相同资金使用或组合互补性目标下必然更差。先确定用户的评价目标。

对于你的系统，诊断要区分“观察到了什么”“可能的原因”“怎样反证”“修改后是否实测改善”。不要用肯定的口气把相关性变成因果。

**七、前端体验：值得复现的组件与数据契约**

| 组件 | 用户要回答的问题 | 后台至少需要的数据 |
|---|---|---|
| 规则摘要卡 | agent 有没有理解我的意思？ | spec、默认值、未决歧义、规则 ID |
| 阶段任务树 | 正在做什么，卡在哪？ | phase、状态、子任务、开始/结束、可重试错误 |
| 策略版本头 | 现在看的哪一版？ | strategy_id、version_id、parent、状态、运行 ID |
| 核心指标 | 整体是否值得进一步看？ | 统一 metrics、区间、成本和基准信息 |
| 权益/回撤图 | 收益何时产生，回撤持续多久？ | 时间序列、现金、持仓、benchmark |
| 月度热力图 | 是否依赖少数行情？ | 月度复合收益、覆盖期、未完成月份标记 |
| 滚动指标 | 稳定性如何？ | 窗口、采样频率、最小样本数 |
| 交易列表 | 哪些交易产生了结果？ | trade ID、规则 ID、价格、费用、exit reason |
| 退出归因 | 是止损、止盈还是时间退出影响结果？ | exit reason 聚合、样本数、盈亏与持有时间 |
| 资产归因 | 是否由少数币种主导？ | 分品种净贡献、敞口、交易数量与样本期 |
| 入场后路径 | 信号有效但退出不合理吗？ | 全部信号的 forward path，MFE/MAE、分位数与有效样本数 |
| 诊断 artifact | 为什么建议这样改？ | 文本、表格与图表引用、evidence ID、适用版本 |
| 版本比较 | 改动到底带来什么？ | spec diff、相同条件下的 v1/v2 结果与验证状态 |
| 模拟/实盘入口 | 怎么把研究带到执行？ | 不可变版本、账户配置、容量/风险校验和部署状态 |

表现细节应这样做：

1. **对话与主面板使用不同滚动区域。** 新结果完成后提示可查看，避免把正在读旧报告的用户强行拉走。
2. **默认只展示 5–6 个关键指标。** 总收益旁一定显示区间与 CAGR；回撤旁显示最长未恢复时间。其他指标可展开或自选。
3. **让图表是证据入口。** 点某个最差月份，交易列表和退出归因跟随筛选；点某笔交易，查看 signal snapshot 和入场/出场原因。视频证明了各面板存在，但没有证明已经实现这种联动；这是建议加强项。
4. **原版在新回测期间保持可用。** 明确标记“正在生成 v2；当前图表为 v1”，不要让用户误把旧 33.31% 当成新版结果。
5. **按结果对象加载。** 聊天先出现简短解释；summary、曲线、交易列表分别到达，不要求全部计算完成才能看到任何内容。
6. **报告是可展开 artifact。** B 的报告可在大弹窗阅读，提供分享、下载、打印、放大等入口。研究材料可以长期引用，而不是埋在消息里。
7. **记录真实进度。** 有 24 个实验就显示完成 8/24；无法预估的脚本显示运行时间与当前步骤。不要伪造百分比。
8. **友好的错误恢复。** 默认显示“正在修复基准数据的时间对齐”，展开后可看错误类型、重试次数和详细日志；不要展示模型私有思考过程。

视频中可改进的交互：主图策略为蓝色、基准为黄色，但诊断图里 SPY 变成蓝色、策略变成黄色；年度比较用策略美元盈亏和 SPY 百分比双轴；小图标题相互重叠；一些中文把 SPY 显示成“间谍”，把 gap 翻成“差距”。后者可能涉及浏览器翻译，不能据此断定 Horizon 本身的本地化实现。你的系统应让交易代码、单位、指标 key 不参与通用翻译，并统一系列颜色。

Horizon score 的权重与校准无法确认。不要模仿一个神秘的 0–100 分。MVP 可先给可解释的“数据完整性、样本量、成本敏感性、验证通过情况”；如后续加入总分，公开定义、版本和限制，禁止把它呈现为赚钱概率。

**八、建议的整体架构**

```text
聊天 + 策略面板 + 研究 artifact 查看器
                  │
          API / 事件流 / 权限边界
                  │
       会话编排器 + 任务状态机
         ┌────────┼────────────┐
         │        │            │
    策略编译服务  研究沙箱    实验编排服务
         │        │            │
         └────数据快照与结果仓库─┘
                  │
          确定性回测引擎
                  │
       同语义的 paper/live runner
                  │
         交易场所适配器 + 风控
```

“策略工程师、研究员、实验评估者”首先是职责与权限边界，不要求三个模型同时运行。MVP 一个模型加按阶段开放的工具就能做到；把回测、指标计算、风控检查交给普通代码。只有独立评审或并行研究确有收益时，再拆成独立 agent。

建议区分这些对象：

```text
Conversation：对话和意图上下文
Strategy：长期策略身份
StrategyVersion：不可变规则快照，包含 parent/diff/hash
BacktestRun：版本 + 数据 + 配置 + 引擎版本 + seed 的一次运行
ResearchSession：针对某个 run 的问题和研究任务
Experiment：假设、候选版本、允许改动、训练/验证预算
Artifact：表、图、Markdown、日志、数据文件
Deployment：一个版本在一个账户及风险配置上的运行实例
```

策略版本与回测运行必须分开：用户只改手续费会产生新的 run，不必产生新的交易逻辑版本；改变 EMA 周期或止损语义才改变策略版本。某个版本可以有多个数据区间和成本假设下的 runs。

持久化建议：关系数据库保存对象、任务和小型指标；对象存储保存 Parquet、交易数据、图表数据和报告。快速原型也可先用 SQLite 与本地文件。长任务由 job worker 执行；编排器保存可恢复状态；SSE 足以传递服务端进度，只有确需双向实时协同时再增加 WebSocket。这是工程选择，不是 Horizon 技术栈考证。

**九、tool 设计：既保留灵活性，也控制数值语义**

建议第一版开放以下功能面，按阶段缩小可见工具集合。

| Tool | 关键输入 | 关键输出 / 不变量 |
|---|---|---|
| `capabilities.describe` | venue、市场类型 | 支持的 bar、订单、数据、规则能力 |
| `instruments.resolve` | 自然语言/代码 | 唯一 ID、市场、合约单位、精度、上市时间 |
| `data.prepare_snapshot` | 品种、区间、频率、字段 | snapshot_id、覆盖率、缺口、校验值 |
| `strategy.validate` | spec | 单位/时序/风险/状态检查和结构化错误 |
| `strategy.create_version` | spec 或 parent+patch | 不可变 version_id、可读规则 diff |
| `backtest.submit` | version_id、snapshot_id、config | run_id；幂等提交 |
| `jobs.get` / `jobs.cancel` | job_id | 状态、阶段、结果索引、明确的取消状态 |
| `results.query` | run_id、指标或筛选条件 | 有口径、样本量和 provenance 的数字 |
| `research.execute` | script、挂载 artifact IDs、预算 | stdout/stderr、exit code、输出清单 |
| `artifacts.register` | 路径、类型、来源 IDs | artifact_id，安全预览所需元数据 |
| `experiments.compare` | baseline/candidates、评价协议 | 可比性检查、差值、约束、选择理由 |
| `deployment.prepare` | version_id、账户及模式 | 可审阅部署清单；与研究权限独立 |

研究沙箱支持 Python 与受控库、只读历史快照、可写工作目录、CPU/内存/墙钟预算。它不能凭脚本获得生产交易凭证。图表和 Markdown 可以灵活生成，但收益、Sharpe、费用等引用统一指标库。沙箱产物先校验 schema 和数据 ID 再进入前端。

错误应可被机器消费：

```json
{
  "status": "failed",
  "error": {
    "code": "TIMESTAMP_ALIGNMENT_ERROR",
    "retryable": true,
    "details": {
      "left_timezone": "UTC",
      "right_timezone": null,
      "right_source_timezone": "America/New_York"
    }
  },
  "job_id": "diagnostic-001"
}
```

时区修复不是无条件加 `utc=True`。有时必须先按来源时区 localize，再转 UTC；否则本地时间会被错误解释为 UTC。随后检查交易日、bar open/close 标记和共同索引。这个具体问题正是 B 暴露出的内部恢复能力。

给模型的研究约束可以写成：

```text
你是策略研究工程师。
先读取 run manifest；只使用该快照及显式登记的数据。
收益和风险数字必须引用计算结果或统一指标库。
将结论分为 observation、hypothesis、test_result。
不得用“排除后来亏损的样本”证明信号有优势。
提出修改时输出 patch、理由、反证方式和风险变化。
编译/执行错误最多修复三次；失败时保留原产物并报告。
没有完成的候选回测不得宣称优于 baseline。
超出用户指定的策略改动必须明确写在 diff 中。
```

修复次数三次是建议默认值，可以配置，并非 Horizon 限制。

**十、策略中间表示应支持哪些语义**

建议先做受限 JSON DSL，再编译到引擎。不要在 MVP 里承诺任意自然语言都能安全转成任意代码并实盘。

需要覆盖：

- 品种与组合范围、数据依赖、signal timeframe 与 execution timeframe。
- 指标 DAG，每项带 `available_at`；上级周期指标只有收盘后可读取。
- 条件表达式、跨 bar 序列、冻结锚点、超时、重置、冷却。
- 入场提交时间与成交假设分离。
- 止损、止盈、保本、移动止损、时间退出的优先级。
- 目标仓位与风险预算分离，账户总敞口、相关资产组敞口和最大并发仓位分别设置。
- 费用、资金费、滑点、成交模型与策略规则分开存储。
- 不支持的规则必须报错；不得悄悄降级为相似策略。

附带的 `crypto-strategy-contract.json` 给出了一个 crypto 版“突破—回踩—重新站上”的具体示例。它是建议方案，不是 Horizon 导出的真实结构。

每笔交易保存可解释证据：

```json
{
  "trade_id": "trade-123",
  "version_id": "v2",
  "signal_id": "signal-456",
  "signal_time": "2025-02-01T12:00:00Z",
  "signal_available_at": "2025-02-01T13:00:00Z",
  "submitted_at": "2025-02-01T13:00:00Z",
  "entry_rule": "breakout_retest_reclaim",
  "snapshot": {"reference": 98000, "volume_ratio": 1.4},
  "exit_reason": "initial_stop",
  "initial_risk_per_unit": 700,
  "fees": 1.9,
  "funding": 0,
  "accounting_currency": "USDT"
}
```

以上数字只是 schema 示例，不是市场测量值。实盘的成交时间还要保存交易所确认值，不能由提交时间推断。

事件协议建议：

```json
{
  "event_id": "ev-1042",
  "sequence": 1042,
  "job_id": "job-v2-01",
  "strategy_id": "strategy-01",
  "version_id": "v2",
  "run_id": "run-v2-01",
  "type": "phase.completed",
  "phase": "semantic_validation",
  "payload": {"errors": 0, "warnings": 1}
}
```

还需 `artifact.ready`、`run.completed`、`run.failed`、`experiment.candidate.completed` 等。前端按 sequence 去重和补拉；旧任务晚到的事件不能覆盖当前版本。重复提交用幂等键映射到同一 job，而不是启动两次付费回测。

**十一、如何做一个比 demo 更可靠的优化 loop**

先把“更好”转成实验目标，例如：在相同费用、数据和总敞口约束下，提高验证期的风险调整收益；同时展示收益与回撤的 trade-off。不要默认最大化胜率或样本内总收益。

对于 demo 的问题，建议先做可解释的消融实验：

| 候选 | 只修改什么 | 要检验的假设 |
|---|---|---|
| Baseline | 不修改 | 同配置可重复 |
| A | 初始止损距离乘 2；保持风险预算 | 原止损是否过紧 |
| B | 保本触发点推迟或关闭 | 提前保本是否截断有效趋势 |
| C | 时间退出从 15 到 10 bars | 后 5 bars 是否只占用资金 |
| D | 加入波动率过滤器 | 是否能用事前可得规则识别适配环境 |
| E | 改持仓上限，固定总敞口 | 原因究竟是资本竞争还是信号质量 |
| F | 组合通过验证的改动 | 效果是否能共同成立 |

移除历史最差资产可以作为探索分支，但不应作为主结论。每个实验记录假设、参数、成本、试验次数、失败结果和选用理由。

建议的起始协议示例：训练 2021–2023，验证 2024，最终保留测试 2025；前提是这些数据未被此前研究看过，而且目标资产在对应时间确实可交易。日期仅是模板，必须按实际研究历史调整。若已经用 2025 调过策略，2025 就不能再称为独立测试。

训练窗口用于提出候选；验证窗口用于有限度选取，反复查看也会使验证期受污染；候选锁定后最终测试仅使用一次。如果失败后再根据测试结果修改，应登记新研究轮次并获得新的未来验证数据。可用滚动 walk-forward 评估，但不能把每个测试窗口都回流给同一轮参数选择。

对于最多持有 H 根 bar 的标签或 forward return，切分边界需留足隔离，避免训练样本的收益标签延伸进验证/测试期。指标 warm-up 只允许读取之前可见数据，且不计入该期收益。

参数搜索只在定义好的空间内进行。例如先固定结构，再研究 stop_multiplier∈{1,1.5,2}、hold_bars∈{10,15,20}、breakeven_trigger∈{1,1.5,2}，共 27 个候选，而不是让 agent 无限调整所有规则。这 27 个候选不是推荐参数，是搜索预算示例。

排序方式建议先做硬约束，再做 Pareto 比较：

```text
剔除：数据缺失、未来信息、超敞口、不可成交、有效交易样本不足
→ 展示：验证收益、最大回撤、波动、成本、尾部风险、交易频率
→ 按明确目标排名，保留风险/收益前沿
→ 对候选做邻近参数、成本加倍和不同行情段检查
→ 锁定候选后检查最终测试
```

低于某个交易数并不是统计上普适的失败阈值；最低样本数应按策略频率、持仓重叠、有效独立样本和置信区间确定。不能把“至少 100 笔”当作已证明足够。

停止条件应包括：达到试验或费用预算、连续若干轮无验证改善、候选只靠放大敞口改善、没有稳定参数邻域、数据无法支持目标精度。失败结果应是一等产物：“本轮没有找到可信的改进”，这比总能输出一个更漂亮版本更有长期价值。

【参考实现来源】Freqtrade 官方提供 Hyperopt，把参数搜索落实为重复真实回测；也提供 lookahead-analysis 检查部分前视问题。这些可作为你的工具后端，但不代表 Horizon 使用它们。检测通过也不是不存在全部偏差的证明。[Hyperopt](https://docs.freqtrade.io/en/stable/hyperopt/)、[Lookahead analysis](https://docs.freqtrade.io/en/stable/lookahead-analysis/)

**十二、迁移到 crypto：不能只替换 ticker**

**信号。** 连续交易的 crypto 一般没有股票日历式隔夜开盘跳空。连续 K 线 open 与前一根 close 接近，直接搬“高开 0.5%–2.5%”可能导致信号极少，或者触发的是数据缺口。可以保留“冲击—回踩—重新确认”的结构，改用突破此前 N 根最高价、相对成交量、回踩被冻结水平和收盘重新站上。这是新策略假设，需要重新验证。

**现货/永续。** 最先明确市场类型。现货数量、借币做空、线性合约张数、反向合约价值、保证金与名义敞口不能共用一个含糊的 quantity。先做单交易所、USDT 现货、多头、小时线，会显著减少模拟与执行语义的不确定性；永续作为明确的下一阶段。

**数据。** 需要交易所和市场唯一标识、UTC 时间、bar 起止、是否已闭合、上市/下市时间、缺失区间、价格/数量精度、最小名义金额。历史选币不能用今天存活的币列表回填过去。以太坊同名 token 还需 chain 和合约地址，不能靠 symbol 唯一识别。

**永续额外数据。** 历史资金费及实际结算时间、标记价、指数价、合约乘数、维护保证金规则及其版本。资金费支出与头寸方向和结算时持仓有关；不应假定所有合约永远 8 小时一次，也不能用当前 funding rate 重建历史。

**成交成本。** 拆成手续费、买卖价差、滑点/市场冲击、资金费、借贷利息；链上另加 gas、失败交易费用、路由、区块延迟和 MEV 影响。一个“滑点概率”旋钮不足以表达。先用明确的 bps 压力场景，获得订单簿数据后再做容量/深度模型。

**同根 bar 路径。** 回踩、站上、止损、保本和止盈可能发生在同一根 K 线。对于强路径依赖的策略，需要更细执行数据；无法获取时必须标注保守假设及精度等级，不能用一根小时 OHLC 假装知道所有顺序。

**基准。** 至少有 BTC buy-and-hold、目标资产等权组合和现金；按目标可增加暴露匹配/波动匹配基准，但其权重必须事前固定或滚动估计，不能用整个测试期的未来波动率设置过去仓位。

**用户可见的数据。** 除 Horizon 的常规项外增加：手续费与 funding 拖累、总/净敞口、杠杆峰值、强平距离或模拟强平事件、币种与板块集中度、周末/时段表现、缺失数据率、未成交/拒单比率、估计容量。纯现货界面不要显示不适用的强平指标。

**执行衔接。** 回测后先产生 paper deployment，实时接收行情、记录订单与模拟成交，检查信号时序、拒单和成本偏差。实盘启动应绑定版本、账户、额度和风险配置；这个权限与“优化一下策略”分离。本文没有执行任何交易或部署。

【数据资料】CCXT 官方手册提醒当前蜡烛可能未闭合，OHLCV 也可能缺失。它可以提供统一接入，但不自动解决完整历史覆盖和数据偏差。[CCXT Manual](https://github.com/ccxt/ccxt/wiki/Manual)

【数据资料】OKX 提供历史行情、资金费等下载/接口能力；不同类型、区域和时间范围的可用性要在准备快照时检查，不能承诺一个接口覆盖全部历史。[历史数据](https://www.okx.com/en-us/historical-data)、[API 文档](https://app.okx.com/docs-v5/en)

**十三、如何选择引擎与实现范围**

| 路线 | 适合什么 | 成本与边界 |
|---|---|---|
| Freqtrade 适配层 | 较快验证常见 crypto bar 策略、回测与参数优化 | 要核对回测成交假设、复杂组合和路径依赖支持；别把任意 DSL 都强塞进去 |
| NautilusTrader 适配层 | 事件顺序、订单生命周期、组合和后续模拟/实盘一致性更重要 | 数据与交易场所适配、配置和工程投入更高 |
| 完全自建 | 已有成熟执行/风控内核，或规则高度独特 | 数值与时序验证成本最高；不要同时从零做所有层 |

【官方文档】NautilusTrader 的回测共享 live 核心组件，这是选择它研究“同一规则跨回测和执行”的依据。实际成交仍会受数据精度、延迟和模型假设影响。[NautilusTrader Backtesting](https://nautilustrader.io/docs/latest/concepts/backtesting/)

我的建议：先把 StrategySpec、数据快照、统一结果协议与版本体系做成你自己的资产，引擎以适配器接入。如果你最关心 demo 级产品验证，用一种引擎支持三类策略即可；如果主打复杂状态机与永续执行，优先验证事件引擎能否准确表达订单和风险语义。不要为追求通用性一开始支持所有交易所和所有 DSL 节点。

**十四、一个可复现的最小交付方案**

附带 `crypto-strategy-reference.py` 是无第三方依赖的微型语义演示：一个现货品种、顺序突破/回踩/确认、下一 bar 开盘成交、初始止损、+1R 后次 bar 保本、时间退出、费用与滑点、资金及单仓风险上限。它用合成 K 线验证时序，输出 JSONL 事件、交易记录和摘要。

它不是完整回测引擎，不连接 LLM、不拉真实行情、不执行交易，也没有实现多资产调度、部分成交、资金费、真实订单簿或超参搜索。它的作用是让工程团队可以直接运行并检查最容易写错的规则，而不是制造一份假的“crypto 回测收益”。Horizon 的 33.31% 无法仅凭录屏复算，需要完整规则代码、行情快照和执行配置。

运行方式见 `reproduction-readme.md`。配套测试检查：状态过期、锚点冻结、不得使用未来 bar、止损与保本的时序、跳空跨止损的入场拒绝、费用计入、退出事件等。

真正产品化按四个里程碑推进，下面是依赖顺序而非工期承诺：

| 阶段 | 必须完成 | 可验收结果 |
|---|---|---|
| 1. 单策略可信回测 | 数据快照、受限 spec、引擎、指标、交易证据 | 固定输入重复运行相同结果；样例交易可手算核对 |
| 2. Horizon 式工作台 | 聊天、任务事件、策略对象、概览/交易表/设置 | 用户描述策略后能得到版本化结果；刷新后不丢状态 |
| 3. 诊断与优化 | 研究沙箱、基准、归因、patch、候选比较 | 能复现“读取→编写→执行→修复→报告→改版重测” |
| 4. Paper 与 live | 同语义 runner、账户适配、额度/风控、监控 | 模拟信号与回测重放对齐，故障与拒单能恢复 |

验收时至少覆盖以下用例：

- 自然语言包含不支持的数据或订单时明确失败，而不是编造结果。
- 用户修改显示指标不触发回测；修改费用触发新 run；修改规则创建新 version。
- 回测任务重试不重复扣费或创建重复运行；取消后显示取消，不伪装成功。
- 时间戳混用 UTC 与交易所本地时间时能检测并正确转换。
- 相同 bar 出现多个候选信号时，固定排序或显式优化分配，避免依赖数据库返回顺序。
- 更大仓位、较宽止损和更高持仓上限同时出现时能揭示总风险变化。
- 未闭合蜡烛、多周期未闭合值、下市资产、缺失行情不会悄悄制造盈利。
- 盈利、亏损、保本、空样本和未平仓头寸均有明确统计口径；零损失时 Profit Factor 显示无穷/不可比，不随意填 0。
- 新版失败或表现更差时保留 baseline，报告不能自动把候选包装成“已优化”。
- 主图、诊断图、报告和导出里的同一数字可追到相同 run 与指标版本。

**十五、对“最好用户体验”的具体取舍**

理想的第一轮交互可以是：

```text
用户：帮我做 BTC/ETH 的突破回踩策略，风险低一点。

agent：生成可编辑规则卡：
现货、多头、1h；最近 20 根已闭合 K 线高点；放量突破；
下一根回踩；再下一根收盘站上；下一 bar 执行。
每笔初始风险 ≤ 权益 0.5%，总敞口 ≤ 100%。
显示采用的费用、滑点和数据区间。

过程：整理规则 → 检查数据 → 验证策略 → 运行回测 → 分析结果。

结果：策略 v1 + 可核验指标 + 最关键的一个限制。
用户点“为什么输给 BTC？”

agent：读取这个 run；展示基准、暴露差异、退出归因，
提出 2–3 个可检验修改，并展示每项会改什么。

用户：把止损放宽一倍，但不要增加单笔风险。

agent：生成 v2 patch，降低对应数量以保持初始风险预算，
运行相同条件的回测与验证；明确展示收益/回撤/成本变化。
```

这里的体验不是少看数据，而是每一步只展示当前决策需要的证据。初学者可以先看结论，专业用户可以一直钻到规则、快照、脚本和订单事件。

**十六、资料边界与来源**

Horizon 文档中有页面仍保留初始内容脚手架提示，因此其架构表述适合做公开声明的依据，不适合当作完整技术规范。

- [Horizon 官方首页](https://horizon.trade/)：核对产品身份与自然语言策略定位。
- [How Horizon works](https://docs.horizon.trade/concepts/how-it-works)：规则、事件驱动回测、执行流程。
- [Backtesting](https://docs.horizon.trade/guides/backtesting)：指标、成本和偏差注意项。
- [Horizon FAQ](https://docs.horizon.trade/faq)：可修改策略、回测和 broker 工作流。
- [Build a Trading Strategy With AI](https://horizon.trade/academy/build-a-trading-strategy-with-ai)：公开的人参与“构建—检查—回测—修订”流程与保留样本原则。
- [How to Use Horizon Trade Effectively](https://horizon.trade/blog/how-to-use-horizon-trade-effectively)：策略假设、基准、成本、验证期等公开使用建议。
- [Freqtrade Backtesting](https://docs.freqtrade.io/en/stable/backtesting/)：工程复现时需核对的回测能力与假设。
- [Freqtrade Hyperopt](https://docs.freqtrade.io/en/stable/hyperopt/)：参数搜索的可调用后端参考。
- [Freqtrade Lookahead Analysis](https://docs.freqtrade.io/en/stable/lookahead-analysis/)：自动化检查参考。
- [NautilusTrader Backtesting](https://nautilustrader.io/docs/latest/concepts/backtesting/)：事件引擎与共享核心组件参考。
- [CCXT Manual](https://github.com/ccxt/ccxt/wiki/Manual)：市场数据适配及数据限制。
- [OKX 历史数据](https://www.okx.com/en-us/historical-data)、[OKX API](https://app.okx.com/docs-v5/en)：crypto 数据面参考。

仍无法确认：Horizon 的底层模型、实际工具 schema、编排框架、引擎代码、数据源、评分公式、策略编译器、研究沙箱厂商、是否使用子 agent、是否执行自动参数搜索，以及第二段视频之后 v2 的真实表现。

**附：把编排做成可恢复状态机**

以下为实现伪代码，不绑定模型或框架。它补充了函数调用间的状态与权限控制：

```python
async def build_strategy(request, session):
    draft = await model.parse_to_spec(request, capabilities=session.capabilities)
    draft = apply_documented_defaults(draft)
    for attempt in range(3):
        validation = await strategy.validate(draft)
        if validation.requires_user_semantics:
            return persist_pending_clarification(draft, validation)
        if validation.ok:
            break
        draft = await model.repair_spec(draft, validation.structured_errors)
    else:
        return persist_failed_build(draft, validation)
    version = await strategy.create_version(draft)
    snapshot = await data.prepare_snapshot(version.dependencies)
    job = await backtest.submit(version.id, snapshot.id, session.run_config,
                                idempotency_key=session.request_id)
    # Durable continuation: process may restart; job continues independently.
    result = await resume_when_job_finishes(job.id)
    assert_metrics_reconcile_with_ledger(result)
    return publish_strategy_result(version, result)

async def diagnose(run_id, question):
    manifest = await results.get_manifest(run_id)
    plan = await model.propose_diagnostics(question, manifest)
    for diagnostic in bounded(plan, max_jobs=6):
        script = await model.write_analysis(diagnostic, manifest)
        for attempt in range(3):
            job = await sandbox.execute(script, readonly_inputs=manifest.artifacts)
            result = await resume_when_job_finishes(job.id)
            if result.ok:
                validate_output_provenance_and_units(result, manifest)
                break
            script = await model.patch_analysis(script, result.error)
        else:
            record_failed_diagnostic(diagnostic, result.error)
    return publish_evidence_backed_report(run_id)

async def improve(baseline_run_id, requested_patch, protocol):
    baseline = await results.get_manifest(baseline_run_id)
    patch = await model.propose_patch(requested_patch, baseline.strategy)
    validate_patch_scope_and_risk_change(patch, protocol.allowed_changes)
    candidate = await strategy.create_version(parent=baseline.version_id, patch=patch)
    runs = await experiments.run(candidate, protocol.frozen_dataset_and_costs)
    comparison = await experiments.compare(baseline_run_id, runs, protocol)
    # A run finishing is not equivalent to successful improvement.
    return publish_comparison(candidate, comparison,
                              retain_baseline_if_inconclusive=True)
```

每个 `await` 跨越长任务的地方都需要保存任务 ID、结果状态和重试次数。用户刷新、网络断开、模型进程重启，都不应该导致结果丢失或重复运行。读取模型上下文时载入 manifest 与必要摘要，大型交易表由工具按需查询；不要把整个行情库塞进对话。
