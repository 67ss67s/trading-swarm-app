# 策略执行器与判断回放 v3（2026-09-12）

实现范围是 P1 的五族确定性执行器、Lab 无偏评估、净值门与判断回放。研究结论：本次缓存样本没有策略达到晋升标准；不能据此开启真钱。本分支不重启服务，也不改账户/凭证/执行通道。

## 1. 执行器与时间边界

`strategy-signals.ts` 注册 `trend_continuation / mtf / volatility / derivatives / mean_reversion`。SignalFn 只读可见 bars、参数、衍生品历史、regime 与调用方状态，不做 I/O，不读取墙上时钟，不修改输入。setup 给方向、市价/限价类型、十进制参考价及止损距离、真实 ATR、TP 倍数与失效说明。

- trend：不含当前根的前20根突破位，突破窗口内仍在外侧，确认方向、ATR%、追单距离、量比及日线否决。
- mtf：触发周期突破、足够确认周期同向、4h 距 EMA/ATR 强反向否决、日线否决。
- volatility：20根收盘标准差/均值作为带宽代理，过去90个带宽的严格小于分位；低于阈值持续N根后 armed，首次突破且放量才释放。`nextSignalState` 与 SignalFn 分开；调用方以策略版本/币种保留状态，重复同根不会再次释放。
- derivatives：funding 历史均值/标准差计算 z-score；极值方向的反向结构确认；有 OI 时要求降杠杆，无 OI 时只用 funding 并标 `funding_only`。结算前禁开窗口生效。
- mean_reversion：range 日线、距边缘≤0.3 ATR、假突破收回、量衰减；显式配置的 EMA 偏离、ADX 和历史回归概率门也参与。回归概率只由当前已经闭合的历史计算，至少400根。

`measurable(spec)` 检查注册族及必需指标是否有实现，不代表当前样本覆盖足够。未知指标拒绝；无 funding/OI 不伪造零值。

Lab 以不低于 `trigger.min_timeframe` 的周期运行，本次 mtf 用15m而非5m。swing 用4h，position 用1d。周线由日线按 UTC 周一聚合，必须完整连续七天、周收盘≤T；日线指标保留260根，预热400天。现网旧版本若 checklist 仍要求低周期确认，按该不可变版本内容执行，不擅自替换其参数或确认周期。

每根输入 `close_time≤T`，setup 时间必须等于决策根收盘。判断三腿额外沿用 `assertBlind`。Lab 不把未来 bar 交给执行器，只有结算函数读取未来窗口。数据不足完整 horizon 的样本不计入收益。

## 2. 成交与成本

下一根开盘才可市价成交。买限价要求 `low≤limit−tick`，卖限价镜像；触价不算成交，不给予跳空改善价格。OHLC 无法确定盘中顺序：限价从非立即成交侧进入的那根，允许止损但不允许止盈，避免使用成交前高低点。同根 SL/TP 按 SL，止损跳空按开盘；明确的跳空离场记录open_time，成本不计离场之后的资金费。非跳空的盘中离场仍以bar.close_time估计结算时刻。

初始风险距离 `D=direction_sign×(fill−stop)` 固定。`gross_R=direction_sign×(exit−fill)/D`。

```
slip = max(tick, 0.01 × ATR)
fee = entry_price × entry_fee + exit_price × taker_fee
funding = direction_sign × entry_price × sum(settlement_rates)
net_R = gross_R − (fee + slippage_amount + funding) / D
```

默认 taker=0.0005、maker=0.0002；`tradeCosts`/`simulateOutcome` 可传成本覆盖。市价入场及退出各扣一次不利滑点，maker 入场只扣退出滑点。资金费按历史结算事件，缺少的默认8小时结算点用截至退出时可得的30天费率均值估计，并标 `funding_estimated`。整个历史为空时均值不可识别，当前以0占位并明确标估计；因此离线无 funding 的净值仍不是完整成本真相。

默认 tick 为 `1e-8` 的显式估计值，不是交易所 tickSize。调用方有历史 tickSize 应覆盖；当前缓存报告的滑点通常由 ATR 项主导，尚未验证所有币种 tickSize。成本在 R 中扣除，不重新用滑点后的价格调整已冻结止损风险。旧线程回放的 REDUCE 按实际已减比例分别算退出费用与持仓资金费。

兼容字段：`Outcome.r` 和旧线程回放 `r` 仍是 gross；新增 `gross_r/net_r/cost_r`。Lab 顶层 `expectancy_r/total_r` 是 net。漏斗诊断与旧线程 summary 的旧字段保留 gross，新增 `gross/net`，不要把这些旧字段用于晋升。判断回放的 ledger leg `r` 是 net，另给 `gross_r`。

## 3. 无偏评估与公式

预注册 manifest 绑定策略 id/version/content_hash、窗口、参数、代码版本及 universe_rule；运行前核对版本/hash，冻结实际币池、完整探针候选集、family trial计数快照、bootstrap/窗口配置与所有使用周期的缓存 SHA-256，返回 `execution_manifest/data_hashes`。输入 manifest 的 hash 与执行 manifest 的 hash分别保留；后者才是复现已执行实验的标识。

### Anchored walk-forward

首个训练窗60天，此后训练起点固定，训练终点逐步扩张。每个测试窗20天，只纳入完整测试窗。训练末端至测试起点留 `horizon_bars×tf_ms` 的 purge；两段测试之间再留相同 embargo。训练/OOS样本资格均在入场时按预定最大horizon判定：入场≥窗口起点且预定horizon结束<窗口终点。不能用实际止盈/止损退出时间筛样本，否则窗尾只保留快赢交易而删掉慢亏交易。

参数候选仅在每折训练数据中按 net expectancy 排名（至少30个训练样本）；只记获选候选在该折测试窗的净收益。原始候选值、失败及无结果候选均计入 family trial count，不能只记赢家。生产默认持久到 `~/.trade-gate/demo/lab-trials.sqlite`，同 manifest/候选幂等；注入离线 loader 而未注入持久计数器时，只能报告本次计数，不能代表全部历史研究次数。

`is_expectancy` 报首个训练窗净期望，`oos_expectancy/oos_net_expectancy/oos_n` 报样本外净值。position 默认48个日线bar的 purge 为48天，90天不足60+48+20，故本次没有 OOS 窗；这不是实现把它判为亏损。

### CI、DSR 与 regime

固定种子移动块 bootstrap，块长 `ceil(sqrt(n))`，默认2000次、最低1000次；均值的2.5%和97.5%分位形成95% CI。`n<30` 返回 insufficient 和 null 边界，不编显著性。

采用 [Bailey–López de Prado (2014)](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) 的非正态校正概率。每笔净R的非年化 Sharpe 为 `SR=mean(R)/sample_sd(R)`；trial SR 方差至少采用零假设方差 `1/(n−1)`，缺完整候选历史时属于估计。

```
SR0 = sigma_SR × [(1−gamma) Φ⁻¹(1−1/N) + gamma Φ⁻¹(1−1/(N e))]
z = (SR−SR0) sqrt(n−1) / sqrt(1−skew×SR+(kurtosis−1)×SR²/4)
dsr_probability = Φ(z)
dsr = SR−SR0
```

`gamma≈0.5772156649`，单trial取SR0=0。**接口 dsr 是有符号校正 Sharpe，论文的 DSR 概率放在 dsr_probability**；两者不可混称同一数。这样需求里的 `dsr>0` 才是超过试验择优基准，而非“概率>0”这种几乎没有约束的检查。零方差、样本不足返回 null。

OOS 按决策时日线分 `trend`(bull/bear)、`range`、`high_vol`(volatile)，unknown不参与多regime通过数。至少两桶有样本且 net期望非负。回撤从OOS累计净R曲线计算。

### 币池

不读取今天的 TRADING 状态筛掉退市候选。候选来自本地已缓存历史集合；按区间起点前已观测上市≥30天、前30天 `close×base_volume` 排名前N选。只用起点之前收盘；未来高成交额不改变入池。首根缓存时间是保守上市代理，成交额是日K近似而非精确 quote volume；没有缓存的历史退市币仍缺失。因此已消除“直接用今天白名单”的实现，但**不能宣称整个研究宇宙完全没有幸存者偏差**。

## 4. 门与判断回放

`PROMOTION_POLICY` 集中配置，family 覆盖默认空，没有为本次数据放宽门。shadow 门：OOS≥30、net CI下界>0、dsr>0、至少两桶非负、OOS净回撤≤3R。paper 门：shadow≥20、shadow净期望≥0.1R、净回撤≤3R、与Lab OOS净期望差≤0.3R。缺净值/OOS时拒绝，旧 eval 毛收益不能走替代通道。每次 `promoteGate` 将逐项差额写 `demo_strategy_event(kind=gate_check)`。

`POST /api/strategies/lab/run {days:90}` 是 P1 新增的完整 Lab 入口：冻结实验、跑五族及探针、按确切版本写新统计；只有训练选中且 OOS CI/DSR合格才 createVersion(draft)。不会直接切换 active 或启用实盘。

现有 backtest API 显式增加 `legs:['council','mechanical']` 即零模型判断回放；加 model 才调用现有 judgeOnce。三腿同快照、同horizon、同一0.8ATR/1.5R机械风险基线，隔离方向判断而非模拟各策略不同仓位。council 为固定版本执行器方向的多数共识，mechanical 为1h EMA20/50方向。持平/不表态是flat；缺完整未来数据是null。省略 legs 保留旧模型线程回放，避免改变既有 API 行为。

新行 episode_id=`replay:<run>:<index>`，JSON 与迁移0019的 source列均标replay；回放不写 demo_episodes、不改变线上用量。模型回放不提供新闻/记忆。当前固定策略集合是在启动时解析的指定版本，**没有重建历史时点的 active 集合**，因此 council 是预注册策略集合的反事实，不是历史线上议会的完整复刻。

## 5. 上线边界与已知未完成接点

1. 用户独占文件清单之外的 `package.json`、`team-agents.ts`、`strategy-loop.ts`、`judgment-ledger.ts` 未修改，补丁放在 `.codex-reports/strategy-engine-integration.patch` 等待允许/主线接入。当前可直接 `node scripts/lab-cache.mjs`，根 `npm run lab` 尚未注册。
2. 旧定时 labAutopilot 仍丢弃扩展 OOS 字段；新 Lab 路由能写全。旧自动探针排序还需改为仅按训练选择；当前 runExperiment 对未验证探针以 n=0 兼容阻断旧门，真实oos_n留在 replay。此兼容保护不能替代主线接线。
3. 旧线上 shadow 结算仍只有gross；新paper门因此安全拒绝，直到shadow净统计接入。降级仍沿用原 strategy-loop 的 tradeCard 口径，本包没有改写该文件。
4. source已写入列，但旧 `JudgmentLedgerStore.list/count` 未默认过滤online，回放行仍可能出现在旧线上页面/汇总。启用三腿回放前必须应用source查询隔离接点，不能把“有source字段”当成“所有消费者已隔离”。
5. 新SignalFn用于Lab/判断回放；线上 strategy-council 仍是原实现。波动失效说明已输出，但Lab未执行可编程的“收回区间退出”规则，仅共享保护止损/止盈及固定期限结算；完整执行DSL不是本次完成项。
6. 没有盘口/排队/部分成交、真实订单精度/最小名义、新闻、历史OI、历史active集合。交易间重叠、跨币相关及 regime 条件选择尚不能被简单移动块bootstrap完全校正；没有White Reality Check，也不将DSR替代该检验。
7. 未做总组合风险预算/资金曲线仓位约束。净R等权研究统计不等于可交易组合收益。

## 6. 参考依据

- Bailey & López de Prado (2014), *The Deflated Sharpe Ratio*，见上方原文公式与概率口径。
- López de Prado (2018), *Advances in Financial Machine Learning*, ch.7：purged CV/embargo。这里实现时序walk-forward，未声称实现完整CPCV。
- [White (2000), A Reality Check for Data Snooping](https://doi.org/10.1111/1468-0262.00152)：多次搜索偏差的研究依据，未实现其完整检验。
- [Pardo, The Evaluation and Optimization of Trading Strategies](https://doi.org/10.1002/9781119196969)：walk-forward方法背景；60/20是本需求的预注册窗口，不是文献保证的最优长度。
- [Harris, Trading and Exchanges](https://academic.oup.com/book/52292)：微观结构与成本研究背景，OHLC不能代替真实成交队列。
- 仓库背景：`docs/research/strategy-construction-2026-09-05.md`、`docs/design/blind-backtest-2026-09-05.md`。历史文档里的“毛收益/漏斗代理”描述已由本文件限定新旧边界。

## 7. 本次真实缓存结果

窗口2026-06-14至2026-09-12（UTC），起点选18币，现网只读7个head版本；不联网补funding，不修改运行时数据库。耗时 17.7秒。所有策略未过晋升门。

|策略|族|setup|已结算n|gross R|net R|OOS n|OOS net R|CI下界|dsr|
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
|swing_breakout_retest|trend|202|183|-0.0306|-0.1465|24|-0.0572|不足/不可得|不足/不可得|
|breakout_retest|trend|960|959|-0.0573|-0.2907|295|-0.1699|-0.3710|-0.1857|
|position_breakout_retest|trend|59|26|-0.4234|-0.4785|0|不足/不可得|不足/不可得|不足/不可得|
|vol_compression_expansion|volatility|1413|1413|-0.0013|-0.6268|366|-0.7775|-1.0859|-0.4548|
|mtf_alignment|mtf|2517|2514|-0.0579|-0.7183|733|-0.8384|-1.0919|-0.5071|
|range_mean_reversion|mean_reversion|4|4|-0.3534|-1.9271|0|不足/不可得|不足/不可得|不足/不可得|
|funding_oi_extreme|derivatives|0|0|不足/不可得|不足/不可得|0|不足/不可得|不足/不可得|不足/不可得|

完整执行manifest、缓存摘要和分桶见 `.codex-reports/strategy-engine-lab.json`。每族setup合计：trend=1221；其余族分别见表。OOS不足显示null，没有改成零收益。

## P1b：独立影子、版本健康与有效样本（2026-09-12）

- 独立一分钟零模型调度使用 `trigger.min_timeframe` 和 `params.horizon_bars`（未定义时为该策略周期的 48 根）。SignalFn、入场/止损/止盈与成本结算共用；不经过 paper 扫描、容量、模型预算或 council 开关。压缩状态与采样水位持久化，重复采样/冷却受限；周线预热使用足够日线。
- 完整 horizon 的 K 线必须连续、合法且闭合；空/缺/未来根保留待补，退避轮转，不贡献样本。停止运行时等待在途 shadow 任务。线程冻结 setup、version/hash、backend、代际与权益估值点。
- 「代码方向代理成绩」与「完整策略成绩」分账，后者指确定性代码策略完整入退场计划，含模型的成绩另列 eval；方向代理不进入完整策略晋升。费用含估计时仍明确披露 `funding_estimated`，不能称为交易所实际 P&L。
- 健康状态按 effective version × backend 维护；head 为 draft 时仍检查旧有效版。paper/live 资格不能从另一个 backend 继承。降级增加代际和窗口起点，冻结历史 shadow 线程；旧证据不能自动复用，新版本清空健康元数据。人工/自动恢复按 backend 的状态逐级走。
- eval 仅完成且未截断的 run 按 `(id,version,hash)` 写回；cancelled/open/incomplete 不写。正常到期未成交不算成交，也不阻止其他完整成交写回。live_capped 仍须人工确认，且完整 eval 有效 n≥30、净期望≥0.15R。真实降级数据只取同 version/backend、窗口内的完整净结算；旧结算生产者未提供 complete 证明时不入门。
- 同 4h 桶跨币保守视作一个相关簇，门使用有效 n，推断统计与期望使用簇均值；原始交易数单独保留。最大回撤使用同时点合并的并发净清算权益变化，包含持仓期间的闭合 K 线估值；不声称 tick 级或根内最大回撤。
- point-in-time 币池保留全部候选的首末缓存时间、上市年龄不足、历史不活跃、退市/缺尾代理、未入选和加载失败明细。缓存无法区分真实退市与缺尾，明确标注 `delisted_or_missing_tail`。候选池和入选池分别计算失败率，任一超过20%不产出 lab_stats；候选原始内容（含未入选币）与参数全集进入执行 manifest 哈希。
- 每周定时 Lab 只重测固定版本，关闭参数探针及自动择优；手动探针仍按训练窗选择，测试窗只验证。60 天没有足够 60/20 OOS 窗时不能晋升。
