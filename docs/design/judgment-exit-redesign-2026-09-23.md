# 交易判断链:取证、批评与改造方案(2026-09-23)

> 起因:Jacky 观察到 agent「约束不了自己给的盈亏比」「判断容易提前走」「持仓时扫描太频繁但一根插针照样离场」。本文回答:现在的判断基准到底是什么、哪些问题仍然成立、怎么改。落地由 Opus 5.5 做,方案由 Jacky 拍板。
> 取证来源:主库 `~/.trading-swarm/demo/state.sqlite`(18801,币安 MCP 版)的 `demo_threads / demo_episodes / demo_judgment_ledger`;代码以 `~/Desktop/trading-swarm-okx` 工作树为准(判断链两仓相同,`TG_EXCHANGE` 只切行情与执行)。

## 0. 结论(先读这段)

1. **Jacky 观察到的三个现象在数据里全部坐实,但它们来自 09-09 之前的版本。** 09-09(d15a666)加了 horizon 节流与持仓动作闸(holding-policy),模型只有在代码判定「失效已确认 / 双周期反转 / 已核实的利空事件 / 触硬止损」时才被允许 EXIT。**但从那之后到今天,一笔真实持仓都没跑过**(最近 10 天 on-thread episode = 0),新状态机零线上证据。
2. **仍然成立、而且是设计层面的缺陷:双止损不相容。** 盈亏比按硬止损算(≥1.5),而风险在「软失效线」上实现;闸门要求失效价位于入场与硬止损之间,却允许它贴着入场(SPCX 失效价距入场 0.03%,DOGE 0.19%,HYPE 0.15%)。16 笔 agent 交易计划 R 全部落在 1.3–1.65,实际只有 1 笔到止盈。这不是模型「不守纪律」,是几何本身让「守纪律」= 亏小钱。
3. **改法的核心不是再加一条 prompt 规则,是把「策略几何」从模型手里拿回代码**:信号、止损、目标、失效线、追踪由策略对象(研究台 IR)给出并由代码计算,模型只做「跟不跟这个候选」和「叙事 / 风险事件否决」——这正是研究台 C 臂的语义,让研究台的 A/B/C 结果直接决定每条策略上线时模型的角色。配套规范见 `strategy-apply-spec-2026-09-23.md`。
4. **先量再改。** 判断账本(09-12)会算复查期 HOLD/EXIT 的反事实 regret,但它上线时那批交易已经结束,至今 review 行只有 5 条:提前离场这个最需要度量的行为,一次都没被量过。今晚先把历史 episode 回填进账本、按 holding_reason / 触发器 / prompt 版本分层(零模型调用)。

## 1. 证据:主库 18 笔真实平仓(2026-09-04 ~ 09-12)

| 币 | 周期 | 持有 | 模型调用 | 止损% | 失效线% | TP1% | 计划 R | 实际 pnl | 收场 |
|---|---|---|---|---|---|---|---|---|---|
| SOL | 1m | 26 min | 17 | 1.13 | 1.13 | 1.72 | 1.52 | −43.8 | 复查离场(距止损 0.08% 时主动平) |
| SOL | 1m | 94 min | **91** | 1.05 | 1.05 | 1.63 | 1.55 | 0 | 交易所侧平 |
| BNB | 15m | 262 min | 9 | 1.40 | 0.71 | 1.86 | 1.32 | +64.3 | **止盈**(全表唯一) |
| SOL | 15m | 59 min | 6 | 1.03 | **0.17** | 1.45 | 1.41 | +1.4 | 复查离场 |
| HYPE | 15m | 44 min | 4 | 1.32 | **0.15** | 2.18 | 1.65 | −10.0 | 复查离场 |
| SPCX | 15m | 345 min | 12 | 0.75 | **0.03** | 1.14 | 1.52 | −0.2 | 复查离场 |
| CRCL | 15m | 774 min | 31 | 1.10 | 1.10 | 1.53 | 1.39 | −1.3 | 交易所侧平 |
| XAUT | 15m | 88 min | 6 | 0.78 | 0.34 | 1.05 | 1.35 | −0.2 | 复查离场 |
| MU | 15m | 1187 min | 21 | 1.00 | 1.00 | 1.40 | 1.40 | −0.3 | 交易所侧平 |
| DOGE | 15m | 224 min | 5 | 1.78 | **0.19** | 2.70 | 1.52 | −0.9 | 复查离场 |
| ZEC | 15m | 101 min | 3 | 2.31 | 0.48 | 3.66 | 1.58 | −0.3 | 交易所侧平(急跌硬止损) |
| 其余 7 笔 | | | | | | | | | 补偿平仓 / 手动 / 失败 |

读数:
- 复查离场 6 笔、止损 5 笔、止盈 1 笔。计划 R 均值 1.48、标准差 0.10 —— **16/16 落在 [1.3, 1.65]**,prompt 9b 写着「不要从想要的 RR 反推目标」,数据说就是反推的。
- 失效线 / 止损距离比:5 笔 < 0.3(失效线在噪声里),典型的 15m 回踩突破位就触发。
- 1m 线程 91 次模型调用 / 94 分钟。`inferHorizon('1m')='scalp'`,scalp 的 `reviewDue` 恒真;它每根被叫是因为当时 `workflow.timeframe` 就是 1m。
- 判断账本(09-12 上线,晚于这批交易):online 行 2113 条,scan 期 NO_TRADE 1956 / WATCH 151 / PROPOSE 1;review 期只有 HOLD 4 + PROPOSE 1;**这 18 笔的 9 次 EXIT 全在账本之前,一条都没被反事实过**。账本代码已经会算 EXIT 的 hold_r / exit_now_r / regret(P1-12),缺的是样本与回填。
- 扫描侧最近 14 天:`event` 触发 6821 次、心跳 1644 次、breakout 570 次……全部 NO_TRADE;日均 ≈1000 次判断,PROPOSE 率 < 0.1%。

## 2. 现在的判断基准(v11 代码,`PROMPT_VERSION='demo-playbook-v11-formula'`)

**入场**(scan 模式):
- 模型看到:行情/结构(EMA20/50、ATR14、20/50 根摆动、量比,按主周期 + 1h/4h)、代码算的扫描清单(ATR% 门槛、趋势一致、距突破 ATR、回踩确认、RSI/ADX/BB/squeeze/VWAP)、按活跃策略声明的指标集(`StrategySpec.evidence.indicators`,无声明用 ema20/ema50/atr/rsi@1h)、议会共识、日线 regime、时段、触发器、≤5 条记忆、信息员摘要、事件区、账户。
- 模型输出:`direction / entry(market|limit) / stop_price / take_profits[≤3] / invalidation_price / target_price / strategy_id / risk_plan{atr_timeframe, stop_atr_multiple}` + 叙事。
- 代码只拒不改:止损在正确一侧且距入场 0.3%–5%;ATR 倍数 ≥ horizon 下限(scalp 0.8 / intraday 1 / swing 1.5 / position 2)且 ≤ 4;**净 RR ≥ `min_net_rr`(默认 1.5),按硬止损与 TP1 算**;失效价须在入场与硬止损之间。数量/杠杆全由代码按 risk_pct 算。**只挂 TP1,TP2/3 是文字**。
- `auto_approve` 默认 true。

**持仓**(review 模式):
- 复查节奏 `reviewDue`:intraday 每 1h 桶一次、swing 4h、position 24h、scalp 恒为 due(但定时器只按全局 `workflow.timeframe` 收盘调度,runtime.ts:1194-1201——1m 线程每根被叫,是因为当时工作流周期本身是 1m);触硬止损 / attention / 手工 / 成交 / **无 horizon 的手工线程** 绕过节流;fast_move(5 分钟 0.8%,10 秒轮询)和心跳也走同一节流。
- 动作闸 `evaluateHoldingReview` 决定 `allowed_actions`:触硬止损或收盘越硬止损 → 只准 EXIT;论点周期 **连续 `confirm_bars`(默认 2)根收盘** 越过失效价且深度 ≥ `invalidation_buffer_atr`(0.2)ATR,或论点周期 + 确认周期 双双反转 → 可 EXIT;已核实利空事件 → 可 REDUCE/EXIT(**函数里有这条分支,但 runtime.ts:3062 调用时根本没传 `event`,这条路现在不可达**——Codex 抓到的确定性 bug);浮盈 ≥ 1R 且论点周期转弱 → 可 REDUCE(固定 50%);双周期反转要求两个周期的**入场时趋势都等于持仓方向**,入场时中性则永不触发;其它 → 只准 HOLD(模型仍被调用,但只能说 HOLD)。
- **没有追踪止损、没有保本、没有分批止盈**;review 补丁只改 thesis/invalidation_text/watch_conditions,永不碰 stop_price/take_profits。
- 唯一实时护栏是交易所侧条件单(paper 是 10 秒轮询)。

**策略**:`StrategySpec` = 文本规则 + 参数 + 声明的证据字段;信号识别是模型读文本自己做的。同一条策略在 4 处硬编码:`screener.fitConditions`(radar 打分,按 id switch)、`STRATEGY_VERDICT`(议会票)、`SIGNAL_REGISTRY`(Lab 机械执行)、`STRATEGY_EVIDENCE`(证据文案)。新策略掉到通用 5 项打分。晋升 draft→backtest→shadow→paper 全自动(机械漏斗统计),paper→live_capped 要人批 + **30 笔真实交易 ≥0.15R**。

## 3. 仍然成立的缺陷(按严重度)

**D1 双止损不相容(经济学层)。** RR 闸按硬止损算,交易在软失效线死。软线可以贴着入场(闸只要求「在入场与止损之间」)。结果分布:一堆 −0.3~−0.6R 的软离场 + 少数 −1R + 极少 +1.5R——右尾被 TP1 全平截断、左尾靠软离场缩短,期望为负。硬止损的 ATR 下限(intraday 1 ATR)是给错对象的下限——真正承担风险的是失效线,它没有任何下限。**Codex 复审:这条因果链只成立一半**,同一组数据也能用「策略本身没有边」解释(1.5R 目标扣费要 ≥40% 胜率,样本里只有 1 次 TP;软离场可能是在把本来要到 −1R 的亏损缩小)。要分清,必须对每笔做四条配对反事实:原退出 / 只用硬止损 / 延迟确认 / 机械追踪——这正是 P0-1 回填要给的数。

**D2 R 锚定。** 16/16 计划 R ∈ [1.3, 1.65]。目标价不是结构给的,是从「≥1.5」反推。TP1 全平又把上限钉死在 1.5R,赢家不能跑。prompt 里再写十遍「不要反推」也没用,因为没有任何代码校验目标价来自哪里。

**D3 只有全平和 50%。** 没有追踪、保本、按结构分批。研究台 IR 里已有 `chandelier_trail / breakeven_after_r / structure_target`,实盘一条都没有。

**D4 职责错位。** 「判断」同时干三件事:策略信号识别(读 playbook 文本自己找突破/回踩)、风险几何(止损/目标/失效价)、持仓管理(在允许动作里选)。前两件是可复现、可回测的,交给了不可复现的模型;第三件才是模型可能有增量的地方,却没有单独度量。

**D5 度量缺口。** 账本能算 review regret 但只有 5 条样本(历史 episode 没回填);账本没按 holding_reason / 触发器分层,分不出「失效确认后离场」和「心跳离场」;v11 状态机零线上样本;eval 的 `review_counterfactual` 只离线跑。paper→live_capped 的门是 `eval_stats.trades ≥ 30`(strategies.ts:1003,含模型回放的 eval 样本,**不是线上成交**——本文初稿写成「30 笔真实交易」是错的),eval_stats 只由 backtest.ts 的模型回放写入,现网有没有策略攒到 30 笔待查。

**D6 扫描漏斗。** 日均 1000 次判断换 <1 次 PROPOSE。议会的 code verdict(每策略确定性打分)本可以做零模型前置过滤,现在是「先叫模型,再看议会」。

**D7 策略定义散在 4 处硬编码,与研究台 IR 零共享。** 研究台能回测的东西实盘跑不了,实盘在跑的东西研究台复现不了(B 臂只是把 StrategySpec 的文本塞给研究 prompt)。

**D8 scalp 例外。** `inferHorizon` 把 1m/3m/5m 判成 scalp → 每根收盘复查、0.8 ATR 止损。1m 线程 91 次调用就是它。scalp 在这套 harness 里不该存在(模型调用延迟 20–30 秒,1m 周期没有意义)。

## 4. 改造方案(三档,推荐 B;A 是 B 的第一步,不冲突)

### 方案 A:最小改(只动闸门与几何,不动职责)
1. **失效线有下限、止损贴失效线**:`invalidation_min_atr`(论点周期 ATR,默认 0.5)—— 失效价距入场 ≥ 它;`stop_max_beyond_invalidation_atr`(默认 0.5)—— 硬止损不得比失效线远超过它。两线贴合 → 计划 R ≈ 实现 R。
2. **净 RR 按失效线算**(`min_net_rr` 的分母改为 entry 到 invalidation + buffer),硬止损只是灾难护栏。
3. **目标价必须有代码可验证的来源**:`target_source ∈ {structure(前高/前低/区间边界/HTF 结构,代码在 K 线上找得到且在合理 ATR 距离)| fixed_r(策略参数)}`;模型给的 `target_price` 若不在任何结构位 ±0.2 ATR 内则拒。R 分布进账本,90% 落在 [1.3,1.7] 触发「锚定」告警。
4. **代码管的追踪与保本**(只收紧、不放宽):浮盈 ≥ 1R 移保本;吊灯线(k×ATR,策略参数)作为第二止损;交易所侧改单。允许分批:TP1 平 50% + 追踪剩余(策略参数决定)。
5. **scalp 删除**:`inferHorizon` 最低 intraday;1m/3m/5m 线程拒开。
6. `PROMPT_VERSION` → v12,eval 全量重跑对照(v11 vs v12 的 outcome_R、review_counterfactual、hallucination)。

### 方案 B:职责重分配(推荐)
- **策略对象(研究台 IR)定义**:信号原语 → 入场候选;`risk.stop` → 硬止损与失效线(同一条线 + buffer);`exit[]` → 目标 / 追踪 / 信号离场;`order` → 入场方式、耐心、加仓、时间止损、保本。
- **代码算候选**:每根策略周期收盘,对 watchlist 跑 IR 信号 → `StrategyCandidate{direction, entry_ref, stop, targets[], invalidation, rr, sizing_bounds}`。没有候选就不叫模型(D6 直接解决)。
- **模型的角色按策略配置**(`agent_mode`):`mechanical`(不叫模型)/ `filter`(follow/skip + 叙事,不能改几何 = 研究台 C 臂)/ `manage`(持仓期在允许动作里选,允许动作由 IR 出场原语触发)。
- **持仓复查 = IR 出场原语 + 硬事件**:追踪/保本/时间止损由代码执行;`signal_exit` 触发时才叫模型(允许 EXIT);心跳只在 `manage` 模式且策略周期收盘。模型不再发明失效价。
- **radar 的 wake 条件 = 同一份 IR 信号在更长窗口上的预检**(研究台 `precheck` 已有),不再按 id 硬编码 fitConditions。
- **上线判定**:研究台 A(机械)/ C(模型过滤)在冻结数据上跑;`alpha_C − alpha_A > δ` 才给 `filter`,否则 `mechanical`。B 臂(模型自由判断)只作为研究基线,不上线。
- 保留:gates.ts 的账户级闸、portfolio 组合闸、risk 哨兵、executor 唯一写入——全部不变。

### 方案 C:全机械 + 模型只做风险事件否决
= 方案 B 里所有策略 `agent_mode=mechanical`,模型只在信息员标了已核实利空事件时被问「要不要减仓」。如果 C 臂 alpha 全部 ≤ 0,这就是终态;不需要单独设计。

### 怎么选
不用拍脑袋:账本 v2(§6 P0)+ 研究台 A/C 臂在冻结数据上跑同一批策略,看 `alpha_C − alpha_A` 和 `regret_exit` 分层。A 是无论如何都该做的止血;B 是架构方向;C 是 B 的一个配置。

## 5. 对 Jacky 几个具体问题的回答

- **「judge 只判断该不该在某时刻交易(归 thread),portfolio 再决定止盈止损?」** 现状不是这样:止盈止损是模型在 PROPOSE 时给的,portfolio 只做敞口/簇/止损预算/容量,**不碰任何价格**,超限整单拒(不缩量)。建议:几何(止损/目标/失效/追踪)归策略 IR + 代码;portfolio 管仓位与敞口(可以缩量而不是只拒);thread 管持仓状态机;judge 管「跟不跟候选」和「叙事/风险事件」。
- **「thread 决定看什么指标,radar 决定什么指标 trigger,还是硬编码判断?」** 三处现在各自为政:radar 按 id 硬编码打分;thread 的证据 = 活跃策略声明指标的并集 + 固定结构块;信号识别靠模型读文本。应该都从策略 IR 派生:IR 的原语决定 radar 预检 / 触发 / 证据字段 / 出场;见 apply spec。
- **「策略硬性晋升」**:draft→backtest→shadow→paper 全自动按机械漏斗统计,paper→live_capped 要人批 + `eval_stats.trades ≥ 30`(模型回放 eval,不是线上成交)。建议晋升证据改为研究台 A/C 配对(按「每个候选机会」配对,skip 记 0R;冻结数据几百笔)+ shadow(线上只记不下单,量滑点/资金费/成交率)。paper→live 仍人批。
- **「带 agent 回测没做上」**:研究台 B/C 臂就是带 agent 回测,但用的是研究 prompt,不是生产 harness(context.ts + gates + holding-policy)。`backtest.ts` 已经能用生产 harness 盲回放,缺的是把它包装成研究台的一条臂(`production_harness` 臂)——这也是 self-evolution 文档 §4.3 评估器的落点。
- **「只有最基础的突破回踩且效果不好」**:五条内置策略都是文本 + 参数,研究台 IR 目前只能表达其中约三条(突破回踩 / 均线对齐 / 波动压缩;funding_oi 要数据 adapter,均值回归的历史回归概率门要新原语)。合并时先把这三条译成 IR 走一遍 A/C,答案会比继续调 prompt 快。

## 6. 落地清单

**P0(今晚,Opus 5.5,零模型调用,不改交易行为)**
1. 判断账本回填与分层:用现有 `backfill` 把主库 09-03~09-12 的 review episode(9 次 EXIT + ~200 次 HOLD)在 DB 副本上回填,加 holding_reason / trigger_kind / prompt_version 分层与 `regret_hold`,出一份报告;第三条腿(机械吊灯线管理到底)作为对照。
2. 记忆分域(见 self-evolution 文档 §5)。

**P1(Jacky 拍板后)**
3. 方案 A 全部(§4)。
4. `agent_mode` 与 `StrategyCandidate`(方案 B 的第一块),先只对研究台译出的一条策略走通。

**不做**:再加 prompt 规则治提前离场;把 heartbeat 调更密;让模型改止损。

## 7. Codex 对抗评审后的修订(2026-09-23 凌晨,gpt-5.6-sol high;原文 docs/research/codex-review-judgment-evolution-2026-09-23.md)

照收的:
1. **诊断降级为假设**:D1 的「双止损几何 → 负期望」要靠 P0-1 的四条配对反事实证实,不能先于数据下结论;竞争解释是「策略没边」。
2. **方案 A 改成「拒绝、不搬」且按策略开关**:A.1 失效线过近 → 拒绝候选 / 等更好入场,**不由代码移动策略止损**(止损贴失效线可能把止损率从 30% 推到 60%,固定风险仓位还会因止损变窄放大数量与跳空损失);先在回填数据上跑「失效距离 × 确认根数 × 硬止损距离」敏感度网格再定阈值。A.2 账户 sizing 仍按硬止损/尾部风险,失效线口径只作为 `planned_exit_risk` 统计(两根收盘确认 + 模型延迟 + 滑点让真实退出比失效线更差)。A.3 结构目标只对「本来就有价位目标」的策略要求,信号离场/趋势跟随策略允许无目标;结构位必须由带 as-of 快照的确定性 detector 给,±0.2 ATR 没有统计依据、先别写死。A.4 保本/吊灯/分批不做全局默认,逐策略比较无追踪 / 追踪 / 分批的净期望与尾部。A.5 不删 scalp,改成「低周期不许 LLM manage」(保留机械信号与保护单),并让无 horizon 的手工线程也进节流。
3. **方案 B 的更短路径**:不先做完整 A、不合并状态机;挑一条 long-only 策略做 `CandidateV0` 纵切——线上 shadow 同时记「IR 候选 / 现有模型提案 / 最终闸结果」,覆盖率与语义对齐后,才让该策略的几何切到 IR。`agent_mode` 拆成正交的 `entry_filter` 与 `exit_discretion`;C−A 只能授权 entry_filter,持仓裁量要单独做配对实验。`fitOrderGate` 接 gates 会改止损/目标,不能说成「gates 不变」。
4. **本周先修三个确定性错误**:runtime.ts:3062 不传 `event`(已核实利空事件分支不可达);runtime.ts:3193-3198 召回不传 `strategy_id`(thread_manager 读不到策略层记忆);research/order-gate.ts:49-58 `orderGateFor` 的 `|| !!ir.order`(已转 jacky-f5)。

不照收、写明原因的:
- Codex 说「更少但更好的提案可能恰是改进,不该用 PROPOSE 率守卫」——同意用于 harness 评估(self-evolution §4.4 已删);但 D6 的扫描漏斗(日均 1000 次判断 <1 次 PROPOSE)仍是成本问题,零模型前置过滤照做。

## 8. P0-1 回填结果(2026-09-23 凌晨,docs/research/ledger-backfill-2026-09-23.md)

主库副本回填 294 行(review 271 / scan 23,18 条已平 + 9 条已撤线程),零模型调用。**每个分层都不过样本门槛,只能定方向**:
1. **提前离场既没多赚也没多亏**:9 次 EXIT 离场合计 −1.47R,同样 9 笔按原计划拿到止损/止盈合计 −1.30R;7 次主观离场省了 0.54R(亏损单少亏 2.51R − 盈利单少赚 1.97R)。§0 第 2 条的「双止损几何导致负期望」**在这批数据里不成立**,Codex 的竞争解释(策略本身没边)更接近。
2. **模型的持仓复查不比两条傻基线好**:254 行在仓复查,模型选择的 regret 0.29R/行,「永远拿着」0.29,「每次都走」0.24;245 HOLD / 9 EXIT ≈ 永远拿着。→ 支持把 `exit_discretion` 默认关掉(方案 B 的持仓侧 = 代码)。
3. **量到的大头是「该走没走」不是「走早了」**:HOLD 的 regret_hold 均值 0.29R,24% 超过 0.5R(事后指标,只能与基线比)。
4. **机械吊灯线(ATR22×3 入场起追踪、不设止盈)是三种管理里唯一不亏的**:18 笔合计 +0.16R;「计划止损/止盈不动」−3.93R;14 笔有离场价的实际毛 R −6.17R vs 吊灯线 −2.52R。→ 直接支持方案 A.4 的逐策略追踪测试,也说明 TP1 全平截断右尾是真实成本。
5. 09-09 后的持仓闸线上只有 6 行,什么也说明不了。
6. **入场侧也一样**:23 行扫描期 PROPOSE 里 18 行可评分,均值 −0.17R,且逐行与机械腿相同——模型给的方向每次都等于 1h EMA 方向。判断在方向上没有信息增量。
7. 按触发分:heartbeat 复查的 regret 最高(0.59R,10 簇),info_update 0.30,breakout 0.27;1m 线程行数占 40% 但每行只 0.16R(horizon 只有 48 分钟),15m 0.41R。

修正后的读法:R 的主要流失口是「拿到止损」(HOLD 的 regret 合计 ≈71R,EXIT 的 ≈3.2R),不是走早;而同一批交易换成追踪线能从 −3.93R 变成 +0.16R,说明**出场几何本身比模型的持仓判断值钱**。优先级改为:先做「持仓管理 = 代码追踪、模型不参与」的 shadow 对照(P0-1 的三条腿可以在线上实时算),再谈失效线几何;D1 保留为设计不一致,「根因」二字收回。
