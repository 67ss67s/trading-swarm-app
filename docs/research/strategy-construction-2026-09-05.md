# Trade Gate 策略构造研究（2026-09-05）

## Part 1 — 策略族分类（taxonomy）

公开文献能证明某些延续、反转、时段与衍生品机制值得检验，却不能给 Binance 永续、指定币种和 5m/15m 可移植的命中率。[Lo–Mamaysky–Wang](https://www.nber.org/papers/w7613)也强调把主观形态系统化检验。因此下列 R:R/命中率全部是「推测」的预注册先验；除明确写“现有”的函数、字段与阈值外，触发组合和失效条件也均属「推测」研究假设。忽略费用时盈亏平衡命中率为 `1/(1+R:R)`，最终必须由仓库的 `outcome_R`、MAE/MFE 和 calibration 替换。

- **趋势延续：breakout/retest。** 触发：现有 20 根高低突破、EMA20 回踩或 EMA20/50 交叉；证据：5m/15m/1h/4h EMA20/50、ATR、20/50 根高低、量比、`扫描清单`、daily regime/session；失效：收盘回到突破位另一侧或高周期反向。 「推测」1.8–3R、35%–50%。[时间序列动量](https://fairmodel.econ.yale.edu/ec439/mosk.pdf)支持“延续值得研究”但其 1–12 月尺度不能外推到 15m。图映射：`none.breakout|retest|ema_cross → scan → PROPOSE`，随后 `pending.HOLD/INVALIDATE`、`position.HOLD/REDUCE/EXIT`；走完 `fresh_evidence/stop/tp/confidence/thread/preflight` 等闸。
- **区间边缘均值回归。** 触发：「推测」daily regime=`range`，价格距 20/50 根边缘 ≤0.3 ATR、假突破收回且量能衰减；证据：高低点距离、ATR、EMA 夹层、量比、最近 4 根、session、spread/depth（后两项待加）；失效：收盘越界 0.5 ATR 或放量扩张。 「推测」1.2–2R、50%–65%。短期反转文献与流动性有关（[Dai 等](https://www.nber.org/papers/w30917)），不能直接视作 crypto alpha。现图无 `range_edge` 事件，可先走 `none.scan → scan`；晋升前应新增确定性触发，不靠模型看图猜。
- **波动压缩 → 扩张。** 触发：「推测」ATR 或带宽处历史低分位后，`breakout+vol_spike` 同根/相邻出现；证据：现有 ATR、20 根区间、量比外，新增 `atr_percentile/range_width_atr/compression_bars`；失效：两根内收回区间且量比衰减。 「推测」2–4R、30%–45%。加密市场存在跨尺度波动级联现象（[Volatility cascades](https://www.sciencedirect.com/science/article/pii/S092753982100030X)），方向仍须由突破决定。图映射：`vol_spike|breakout → scan`，双命中作为同一次 evidence，不双扣预算。
- **Funding/OI 极值与挤仓。** 触发：现有 `|funding|≥0.05%`，但只在 funding 历史 z-score 极端且 OI/价格组合确认时升级；证据：funding、next_funding_at、OI 与 1h 变化、mark-index basis、taker ratio、历史分位（后三项部分待加）；失效：funding 归一、OI 去杠杆而价格未延续，或方向结构不确认。 「推测」1.5–2.5R、40%–55%。[Fundamentals of Perpetual Futures](https://arxiv.org/abs/2212.06888)说明 funding 的锚定机制，不证明它单独预测方向。图映射：`none.funding → scan`；作为 checklist 修饰项，不单独越过 `scan.PROPOSE`。
- **Session/时段效应。** 触发：现有美股开/收盘窗口一次性事件；证据：`sessionInfo()`、距开盘分钟、时段成交量/ATR/spread 分位、风险事件；失效：窗口后两根无扩量或进入周末/清淡时段。 「推测」1.5–2.5R、40%–55%。大样本研究发现时段效应会变且不持续（[Baur 等](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3088472)），故只做条件变量。图映射：`none.session → scan`，若只有日历命中则不调 LLM。
- **清算瀑布 / fast_move 反转。** 触发：现有 5 分钟 `|move|≥0.8%`，再要求 OI 快降、量比/成交主动性激增；无新闻且价格重新进入急动区间才 fade，有新闻或高周期同向则只等 retest。证据：mark ring、OI、funding、vol ratio、news；新增 liquidation、depth、taker imbalance。失效：第二根继续创新高/低且 OI 不降。 「推测」1.5–2.5R、40%–55%。高杠杆强平具有厚尾风险（[Cheng 等](https://arxiv.org/abs/2102.04591)），不可把每次急跌都假设为可反转。图映射：`fast_move → scan/review`；持仓时只触发 v4 度量复查，保护腿优先。
- **多周期对齐。** 它是 meta-strategy 而非独立 alpha：5m 触发、15m/1h 确认、4h regime 否决；swing 则 1h 触发、4h 确认、5m 择时。证据直接复用 `扫描清单` 的 `trend_agree/dist_to_break_atr`、各周期 EMA/ATR/高低点和 daily regime；失效：确认周期收盘反向。 「推测」2–4R、30%–45%。图中所有 none 触发仍进 `scan`；当前 demo 没有独立 `trend_alignment` 闸，宜在模型调用前做 qualifier，而非让 `confidence_floor` 代替趋势规则。

## Part 2 — 策略库数据模型提案

### 不可变版本对象

- `identity`：`strategy_id`、`version`（semver）、`parent_version`、`content_hash`、`status=draft|backtest|shadow|paper|live_capped|retired`、作者/审批人/时间；每次数字变化都生成新版本，旧成交永远指向原 hash。
- `trigger`：`kind/timeframe/direction`、纯函数条件、去重 fingerprint、cooldown、qualifier；只引用注册过的 feature 名，不能嵌任意代码。
- `checklist`：必需/可选 Evidence kind、freshness、完整性、跨周期/side 对称约束与显式拒绝原因；渲染成 `context.ts` 风格的一条「策略清单(代码计算)」。
- `rules`：entry、invalidation、Exit DSL、允许的 graph node/edge、所需 gate、费用/funding/slippage 模型；模型只能在规则给出的有限边中选。
- `params`：十进制字符串值、单位、合法范围、默认值、来源、`tunable_in=backtest|shadow`；live 版本参数锁定，任何 diff 使 `content_hash/plan_hash` 变化。
- `eval_stats`：数据集 hash、时间/币种/regime/side、样本/成交数、trial_count、trigger precision、action_mix、missed_move、expectancy_R、胜率、MAE/MFE、最大回撤、Brier calibration、side_symmetry、费用与延迟；同时保存置信区间与失败样例，不只存一个总分。

### 晋升门

- `draft → backtest`：schema/单位/未来数据 lint 全过；trigger、checklist、rules 可确定性重放。
- `backtest → shadow`：「推测」走样本外与参数敏感度，含手续费/funding/slippage，至少 200 次独立触发；`future_leakage=0`、镜像检查通过，费后 expectancy_R 的置信区间不明显为负，并用 trial_count 计算 Deflated Sharpe，避免挑最好参数。
- `shadow → paper`：沿用设计稿至少 4 周；比较 live 特征与离线重放、would-be 单和 paper fill，记录漏单/滑点/数据缺口；硬不变量沿用 schema ≥99%、evidence ≥98%、stale 100%、越权 0。
- `paper → live_capped`：策略就绪与执行就绪分开，MCP 一致性、故障注入、保护腿金丝雀全绿；只由人批准 `strategy_id+version+content_hash`，先受单笔/日频/日亏/币种上限。回测或 LLM 自评不能解锁 live。

### 长期记忆与“先提案、后批准”

- 平仓 postmortem 与 L-weekly 只可调用 `memory.propose`/`strategy.draft`，输出“观察、机制、可证伪条件、source_refs、受影响版本”，不能调用 `strategies.library.promote` 或修改 live params。
- calibration 按 `strategy_version × trigger × timeframe × regime × side` 保存预测桶、实际 TP-first/expectancy_R、Brier 和样本数；ContextBuilder 只召回摘要与 `lesson_id`，现场 L1 证据优先，校准不得改价位。
- agent 发现“某阈值附近持续 missed_move/负 R”时，创建 `parameter_change_proposal`：旧/新值 diff、理由、失败样例、预计成本、预注册数据集与晋升门；新值只进入 backtest/shadow。
- 审批器先做 schema、范围、数据泄漏、重复试验与 side 对称检查；人批准研究或 promotion。live 指针是单独签名记录，运行中的策略只读该 hash；没有“模型直接 set 参数”的工具。
- 每个候选记录 `hypothesis_id/trial_count`；失败也追加保存，供 Reality Check/Deflated Sharpe 和记忆去重使用，避免 agent 反复换名字试同一想法直到偶然成功。

## Part 3 — 阅读清单

- [Lo、Mamaysky、Wang：《Foundations of Technical Analysis》](https://www.nber.org/papers/w7613)：它示范把主观形态变成可重复算法，正对应 trigger/checklist 的纯函数化。
- [Moskowitz、Ooi、Pedersen：《Time Series Momentum》](https://fairmodel.econ.yale.edu/ec439/mosk.pdf)：它提供趋势延续的严谨基线，也提醒不要把月度证据偷换成分钟级结论。
- [Dai、Medhat、Novy-Marx、Rizova：《Reversals and the Returns to Liquidity Provision》](https://www.nber.org/papers/w30917)：它把短期反转与波动、换手和流动性连接起来，适合设计 range-edge/fast-move 条件字段。
- [Baur 等：《Bitcoin Time-of-Day, Day-of-Week and Month-of-Year Effects》](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3088472)：它发现时段规律不稳定，支持把 session 当过滤条件而非独立方向信号。
- [He、Manela、Ross、von Wachter：《Fundamentals of Perpetual Futures》](https://arxiv.org/abs/2212.06888)：它解释 funding 与 perp-spot 锚定机制，可防止把高 funding 粗暴解释为必跌。
- [Cao、Zhai、Luo：《Anatomy of Cryptocurrency Perpetual Futures Returns》](https://www.research.ed.ac.uk/en/publications/anatomy-of-cryptocurrency-perpetual-futures-returns/)：它系统整理 basis、momentum、volume 与 volatility 预测因子，适合扩展结构化 evidence。
- [Cheng 等：《Liquidation, Leverage and Optimal Margin in Bitcoin Futures Markets》](https://arxiv.org/abs/2102.04591)：它量化强平与杠杆尾部风险，直接服务 fast_move 和仓位上限设计。
- [Binance：《Introduction to Binance Futures Funding Rates》](https://www.binance.com/en/support/faq/detail/360033525031)：它给出实际 funding 支付、间隔与动态调整机制，是实现 funding evidence 的交易所真相源。
- [White：《A Reality Check for Data Snooping》](https://onlinelibrary.wiley.com/doi/pdf/10.1111%2F1468-0262.00152)：它提供多次试策略后的显著性校正框架，适合策略库记录 trial_count。
- [Bailey、López de Prado：《The Deflated Sharpe Ratio》](https://doi.org/10.2139/ssrn.2460551)：它把选择偏差、非正态与回测过拟合合进晋升统计门。
- [Aronson：《Evidence-Based Technical Analysis》](https://www.oreilly.com/library/view/evidence-based-technical-analysis/9780470008744/)：它用科学检验约束技术信号数据挖掘，适合作为 agent 自研策略的方法论。
- [Pardo：《The Evaluation and Optimization of Trading Strategies》](https://onlinelibrary.wiley.com/doi/book/10.1002/9781119196969)：它覆盖 walk-forward 与实盘前验证，可细化 backtest→shadow→live 流程。
- [Harris：《Trading and Exchanges》](https://academic.oup.com/book/52292)：它补足订单、流动性、spread 与市场冲击，是当前仅靠 K 线证据的关键盲区。
- [Freqtrade](https://github.com/freqtrade/freqtrade/blob/develop/docs/backtesting.md)：它的 backtest/dry-run、费用与细周期仿真假设可作为 crypto 策略回放的实现对照。
- [vectorbt](https://vectorbt.dev/)：它适合廉价批量扫参数敏感度，但结果必须回到事件驱动撮合验证。
- [NautilusTrader](https://nautilustrader.io/open-source/)：它展示回测与 live 共用事件模型的工程形状，适合借鉴策略版本和执行一致性。

## 2026-09-12 新族：relative_value（仅离线）

增加独立双腿 `PairSignalFn/PairSetup` 注册表，测试冻结训练窗log-price OLS残差与半衰期；研究固定三对、180d、五个完整20d OOS折。与现有五族的方向入口隔离，不创建active策略。执行协议欠项及所有失败trial见 [相对价值研究](relative-value-study-2026-09-12.md)。本次三对均未通过训练半衰期门，零成交不构成 alpha 的反证或成本压力已通过的证据。
