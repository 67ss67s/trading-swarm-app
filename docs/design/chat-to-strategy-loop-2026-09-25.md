# 对话 → 选币 → 策略研究 → 自动迭代 → 分给角色运行(2026-09-25 设计 + 验收标准)

> 起因:Jacky 09-25。现状三处断层:① agent 实盘默认挂着旧策略库的 `breakout_retest`,看不到也选不了;② 实盘 agent 靠模型判断,研究台的策略是纯指标硬编码,两边口径不通;③ 筛选/雷达、对话、研究台、运行器各自一套,没有一条从「我想交易什么」走到「agent 在跑这条策略」的路。
> 另要求:首页可接各种 API key,每个 agent 的底层可选 CLI 或 API key。对照实验与加速用 Jev(OpenRouter `~typesafe/jev-latest`,Decisions API)。
> 状态:**09-25 Jacky 拍板三项全同意,开工**(旧库退出实盘/默认自由判断;判断要素默认 Jev;允许「没找到」且留出段锁死)。

## 0. 现状结论(代码事实,子代理盘点 + 18811 实测)

- **对话**:只有一套后端 `chat.ts runChatTurn`(Agent 页,角色会话只是换人设,工具集相同);有 `get_screen / run_screen / get_universe_scan / list_my_strategies / get_backtest_report` 等工具,工具调用在气泡下可见。**不会产出「资产 × 短中长」分层推荐,不会把人送进研究台**。
- **研究 loop(§9.44)**:模板式规划器,预算写死 `max_backtests=1 / max_data_calls=12`。实测问「SOL/DOGE/HYPE 各适合短中长什么策略并推荐一个」→ 被降成 `validate_single`:只取 SOL、只 15m、把整句话编译成一条 4h 趋势 IR(计划 15m、IR 写 4h,自相矛盾),推荐是模型凭文字写的,没看任何周期的数据。**不能做矩阵研究**。
- **矩阵引擎其实有**:`research/batch/*`(8 族 × 市场 × 方向 × 周期,训练/验证/留出三段,Deflated Sharpe,扣费 + 资金费),但只能脚本跑,冷数据 55 分钟 + 评估 56 分钟,没接到对话和研究页。
- **根因迭代也有**:`improve/*`(diagnose → 生成器出变体 → 走步验证 → 严格优于冠军才晋升),零模型,能跑多代;研究 loop 里也有 `diagnose_backtest → revise_strategy → run_strategy_revision` 链。
- **「代码 + AI」回测有但贵且离线**:`judgment-replay` 用 GLM/DeepSeek 每候选一次调用,几百次要 6~25 分钟,只能人工 `!` 跑。
- **角色拆分有但只是展示**:`compile-binding.ts` 把 IR 编成 radar/judge/geometry/risk/holding/execution 六片,每条规则标 code/model;但运行器(StrategyRun)不读它,旧 agent 循环也不读它。
- **三套策略对象并存**:旧库 `StrategySpec`(文本规则,喂 agent prompt,`active_strategies` 默认 `['breakout_retest']`,在 `#strategies` 页选)/ 研究台 `ResearchStrategy + StrategyIR` / 运行器 `StrategyRun`。互不知晓。
- **角色间没有真通信**:`EVENT_ROUTES/laneFor` 无人读取;`bot_handoff` 只是审计记录,没有角色消费它触发动作;楼层飞线是 30s 轮询 handoff 表后的前端动画。
- **agent 自主判断的实际效果**:近 500 条判断 NO_TRADE 298 / HOLD 101 / WATCH 97 / PROPOSE 4,4 条提议都没成线程;已结算 431 条按模型选择合计 +12.5R,同时段机械规则 −77.4R。模型的价值在「不做」,代价是几乎不交易。
- **过往研究结论(必须记住)**:内置 4 条策略译 IR 全跑输持有;oracle 改进是噪声;横截面动量是幸存者偏差;批量研究「没有一条扛得住多重试验」。→ 本设计**必须允许「这次没有找到能用的策略」作为诚实结论**,否则迭代环就是过拟合机器。

## 1. Jev 实测(09-25)

- 接口 `POST https://openrouter.ai/api/alpha/decisions`,`{model, state, questions}`,问题三种:`noul`(是/否概率)、`choice`(多选一 + 概率)、`score`(有序档位)。无文本、无推理。
- 一次交易候选判断(641 input tokens,三问):**1.07 秒,$0.000027**。10 美元额度 ≈ 37 万次。
- 同一请求多次跑概率会小幅漂移 → 阈值要留边距,回测与实盘要记录原始概率。
- 本机要走代理(`HTTPS_PROXY=127.0.0.1:7897`);OpenAI 系模型经代理出口会 403,DeepSeek/GLM/Jev 正常。
- key 存 `~/.trade-gate-okx/openrouter.env`(600),不进仓库。

**定位**:Jev 做「判断要素」(跟不跟、行情属于哪类、质量几档),便宜到可以在回测里对每个历史候选都问一遍 → **代码 + AI 的策略第一次能被大规模回测,并且实盘调用同一个函数,回测与实盘口径一致**。LLM(GLM/Claude/DeepSeek)留给对话、规划、诊断解释、写报告。

## 1.5 短线判断依据(Jacky 09-25 补充)

- 短线(3m/5m/15m)只看 K 线不够,判断要素要能用**订单簿**(交易所 WebSocket 深度:买卖盘不平衡、近价挂单墙、大单挂撤)和**清算**(OKX 公共清算流,近 ≤100 条;估算热图仍不接)。它们不是唯一依据,和 K 线原语一起喂给 Jev 的 state。
- **短线只对高流动性资产开放**(BTC/ETH 及成交额、盘口深度过门槛的),小市值山寨在短线档直接不参与矩阵,推荐卡上写明原因。门槛:24h 成交额 + 近价 ±0.5% 深度,数值在契约里定。
- 盘口/清算是实时数据,**历史回测拿不到**(除非自己录)。所以:① 立刻开始录 BTC/ETH 永续的盘口快照与清算(每 2 分钟一帧,落本地),积累样本;② 在攒够之前,短线 AI 臂只能用 K 线 + 成交量特征回测,盘口要素标「实时有效、历史未验证」,进实盘前必须过 G3(前向样本)。
- 参考:fiapp.pro/orderbook/btc 用 BTC 永续盘口每 2 分钟问 Jev 六个 15 分钟前瞻问题(触阻力/守支撑/突破/回落/吸筹/压盘),每次约 $0.00008。本会话用币安 1m K 线给它最近 92 条打分(按「15 分钟内触及阻力位 / 支撑位」理解):阻力 AUC 0.50、支撑 AUC 0.29,**看不出区分度**;但窗口重叠、有效样本只有十几条、标签含义是猜的 → 不能下结论,说明盘口类要素必须走同一套评测。

## 2. 目标链路

```
Agent 对话「我想交易 X / 推荐点币」
  └─ recommend_assets(代码:全市场扫描 + 日线 regime + 三档漏斗)→ 推荐卡:资产 × 短/中/长 + 证据 + 建议策略族
       └─ 「去研究台验证」一键 → Study(矩阵研究)
            资产 × 周期档(短 3m/5m/15m · 中 1h/4h · 长 12h/1d)× 策略族 × 两臂(纯代码 / 代码+Jev 判断)
            训练 → 验证 → 留出(留出段锁死,只在最后看一次)
            └─ 近似可用的格子进迭代环:诊断根因 → 生成变体 → 重跑(每代写明「发现什么问题 → 改了什么 → 结果」)
                 └─ 结果:通过门槛的策略 or「没有找到,原因是…」
                      └─ 存成 ResearchStrategy 版本:IR + 判断要素(Jev 问题与阈值)+ 资产池 + 周期档
                           └─ 「设为 agent 当前策略」一键 → 按 binding 分给 radar/judge/geometry/risk/holding/execution
                                └─ 楼层每张桌显示自己拿到的那片;顶栏可切换策略
```

## 3. 关键设计决定(待 Jacky 拍板的标 ⚑)

1. ⚑ **一个策略概念**:agent 的「当前策略」只有两种取值——「自由判断(无策略,走 playbook)」或「某条 ResearchStrategy 的某个版本」。旧库 `StrategySpec` 退出实盘路径(`breakout_retest` 已有 IR 译文「突破-回踩(内置译文)」,迁过去);`active_strategies` 默认值改成空 = 自由判断。StrategyRun 就是「当前策略」的执行体,`agent` 模式下 judge 角色用 IR 里的判断要素。
2. ⚑ **IR 增加 `judge` 块**:`{engine:'jev'|'llm', questions:[{key,type,instructions,criteria,state_fields}], rule:'take>=0.6 && quality>=1.5'}`。回测和运行器调用同一个 `judgeCandidate()`;binding 的 judge 片直接由它编译,**binding 从展示品变成运行依据**(修复「两份角色切分」)。
3. **Study 对象**(研究台新增,不新造引擎):矩阵调度复用 `batch/families + improve/evaluate runPool`,数据复用 perp/spot 缓存;AI 臂调用 Jev 批量并发;进度走 SSE。研究 loop 新增 `run_study` 工具与 `study` 任务类型,预算按 Study 单独算,不受 `max_backtests=1` 限制。
4. **迭代环复用 `improve/*`**:生成器先用现有 diagnosis/neighborhood/swap,再加一个「LLM 读诊断写变体」的 model 生成器(已预留名字未加载)。每代产出人话记录。门槛不变:扣成本为正、跑赢同敞口持有、Deflated Sharpe、n≥30、留出段不参与选择。
5. **推荐不是模型编的**:`recommend_assets` 是代码工具,数字全来自扫描/regime;模型只挑和写理由,数字必须原样引用(沿用 screener 的防编造做法)。
6. **角色通信做「真」的最小版**:不造消息总线。Study 的每个阶段写一条带 `study_id` 的 handoff(对话→研究员→实验室→队长),下一阶段由这条 handoff 触发(消费即 ack);楼层飞线改订阅 SSE 而不是 30s 轮询,点飞线能打开对应 Study。
7. **模型连接(首页)**:新增「模型连接」:API key 类(OpenRouter / Anthropic / DeepSeek / Z.ai / OpenAI,可加自定义 OpenAI 兼容地址)+ CLI 类(claude / codex / pi,自动探测本机)。每条连接有「测试」按钮;key 只存服务端(状态目录 600 文件),前端只见掩码。再加「角色底层」表:对话 / 研究规划 / 诊断解释 / 判断要素 / 复盘 / 策略过滤,每个角色选连接 + 模型;判断要素只能选决策模型(Jev)或 LLM,默认 Jev。替换现在 workflow 里单个 `brain` 字段。
8. **楼层**:顶栏「当前策略:xxx v3 · 切换」;每张桌显示自己那片(雷达:资产池/筛选;判断:入场规则 + Jev 问题;几何:止损止盈;持仓:离场与追踪;风控:仓位;执行:下单方式),桌上标底层(Jev / GLM CLI / 代码)。

## 4. 验收标准

**A. 对话 → 推荐**
- A1 在 Agent 对话里说「我想交易 SOL/DOGE/HYPE」或「推荐几个币」,至少调用 2 个可见工具(全市场扫描 / regime / 三档漏斗),返回一张结构化推荐卡:每个资产 × 短/中/长 给出「适合 / 不适合 + 一句证据 + 建议策略族」,卡上数字可点回来源。
- A2 推荐卡一键「去研究台验证」,自动带上资产、周期档、策略族,用户不需要重新输入任何东西。

**B. 矩阵研究**
- B1 一个 Study 跑 资产 × 周期档(短 3m/5m/15m、中 1h/4h、长 12h/1d)× 策略族 × 两臂(纯代码 / 代码+Jev),扣手续费、滑点、资金费,训练/验证/留出三段。
- B2 3 资产 × 3 档 × 8 族,数据已缓存时 ≤15 分钟出完整矩阵;冷数据有进度与预计时间,可取消、刷新可恢复。
- B3 结果页是一张矩阵:每格净收益、对比持有、笔数、Deflated Sharpe、AI 臂相对纯代码臂的增量(带置信区间);不合格的格子写明主因(费用吃掉 / 样本不足 / 跑输持有 / 回撤)。
- B4 「没有找到通过门槛的策略」是合法结果,页面写清原因,不硬凑一个出来。

**C. 自动迭代**
- C1 验证段接近门槛的前 k 格自动进入迭代环,每一代可见「诊断出什么问题 → 改了什么 → 验证段结果」。
- C2 留出段全程不参与选择,只在最终给出一次;最终结果同时报验证段与留出段。
- C3 迭代有预算与耐心上限,耗尽即停并说明。

**D. 产出与运行**
- D1 通过的策略存成 ResearchStrategy 新版本:IR + judge 块(Jev 问题与阈值)+ 资产池 + 周期档;binding 页能看到六个角色各拿到什么、各由谁执行(代码 / Jev / LLM)。
- D2 「设为 agent 当前策略」一键生效(模拟盘缺省,实盘需输入 LIVE),运行器按 binding 执行;同一根 K 线同一候选,实盘与回测的代码结果一致、Jev 概率差 ≤ 阈值边距。
- D3 agent 的「当前策略」在 Agent 页顶部和楼层顶栏可见可切换;「自由判断」是显式选项;旧 `breakout_retest` 默认挂载去掉。

**E. 楼层与通信**
- E1 Study 各阶段产生带 study_id 的真实 handoff,下一阶段由它触发;楼层飞线来自 SSE 实时事件,点击可打开对应 Study / 策略。
- E2 楼层每张桌显示当前策略分给它的那一片以及它的底层。

**F. 模型连接**
- F1 首页「模型连接」可添加 / 测试 / 删除 API key 与 CLI 连接;key 不回传前端明文、不进日志、不进 git。
- F2 每个角色可选底层(连接 + 模型),改完立即生效;判断要素默认 Jev;某连接失效时该角色明确报错而不是静默回退。

**G. 评测(由 astra 设计并实现)**
- G1 安慰剂:在打乱收益的合成数据 / 随机游走上跑整条链,通过门槛的比例 ≤ 名义假阳率(防过拟合的底线)。
- G2 推荐:历史若干时点 as-of 重放推荐,推荐资产的后续表现 vs 全市场随机抽样基线。
- G3 AI 臂:Jev 臂 vs 纯代码臂在留出段的配对差(bootstrap CI);对照组:同样问题换便宜 LLM(DeepSeek/GLM flash),比较增量与成本。
- G4 一致性:同一段历史,运行器重放的候选与回测逐条一致。
- G5 成本:单个 Study 的 Jev 花费、LLM 花费、耗时都记账,并在结果页显示。

## 5. 分工与顺序(对接后执行)

依赖:另一会话的 StrategyRun(§9.51)还没提交,且在频繁重启 18811 —— **先等它提交**,本线在独立 worktree + 独立端口开发,避免互相打断。

- P1(并行,互不重叠):
  - astra xhigh:Jev 客户端 + IR `judge` 块 + `judgeCandidate()`(回测 / 运行器同源)+ Study 后端(复用 batch/improve)+ G1/G3/G4 评测。
  - Opus 子代理:模型连接后端(连接表、角色底层、替换单一 `brain`)+ 首页连接页。
  - 本会话:契约(v3-ui-contract 新节)、`recommend_assets` 工具与推荐卡、研究页矩阵结果页、整合。
- P2:迭代环接 Study(含 model 生成器)、handoff 触发与楼层 SSE、当前策略统一(退旧库)、楼层分片显示。
- P3:便宜模型(codex 5.6 / 6-sol)按 G 系评测跑一轮,把问题回给 astra 修;本会话收口前端与验收。

## 6. 需求清单与进度(随做随更新;最近更新 2026-09-25 04:26)

主需求(Jacky 09-25):
- [x] R0 先定验收标准 → 本文 §4(A–G),astra 评审后收缩首版(15m/4h/1d、两臂、冻结一套 judge)
- [~] R1 默认策略规范化:agent「当前策略」= 自由判断 / 一条研究策略;Agent 页与楼层可见可切换;旧库 breakout_retest 退出开仓 → 后端+前端已提交(756d83d、095c927),未联调
- [~] R2 对话里说交易什么 → 推荐短/中/长线(工具可见)+ 建议策略族 → recommend_assets + 推荐卡已提交,未联调;「去研究台验证」跳转的研究页落地页未做
- [~] R3 自动转研究台,按资产 × 周期档 × 策略族跑矩阵回测,纯代码与代码+AI(Jev)两臂 → 后端:matrix study 服务(Opus 子代理)、judge/回测接入(astra)进行中;研究页矩阵界面未做
- [~] R4 出现正/负结果后自动找根因 → 改 → 重跑(迭代环,留出段锁死,允许「没找到」)→ 在 matrix study 里复用 improve,进行中
- [~] R5 产出策略 + 判断要素 + 资产,拆给各角色,一键切换去跑 → adopt(进行中)+ 当前策略切换(已完成)+ 楼层每桌显示分到的规则片与执行者(已完成);运行器按 IR judge 执行(astra 进行中)
- [~] R6 评估现有组件能力并优化(context/tool/loop/agent 架构/agent 通信/楼层展示)→ 盘点已完成(§0);真实 handoff 带 study_id(进行中);楼层飞线改订阅 SSE 已移交楼层 v4(jacky-26)
- [~] R7 Jev 做对照实验与加速 → 已接入并实测(1–1.6s、$0.00002–0.00003/次);G3 对照(Jev vs 纯代码 vs 便宜代码过滤 vs DeepSeek)脚本进行中,真跑约 $2 需确认
- [ ] R8 分工:astra 写后端与 eval → 进行中;便宜模型(codex 5.6 / 6-sol)按评测复审 → 回给 astra 修 → 未开始;本会话整合 + 前端 → 进行中

补充需求:
- [x] R9 首页模型连接:API key(OpenRouter/Anthropic/DeepSeek/Z.ai/OpenAI/自定义)+ 本机 CLI,7 个角色各选底层 → 已提交 095c927,未在浏览器验收
- [x] R10 三项拍板(旧库退出/判断要素默认 Jev/允许没找到且留出锁死)→ 已写入设计与实现
- [~] R11 短线依据加盘口与清算,短线不做小市值 → 流动性门已实现(推荐里短线只给高流动性永续);盘口/清算录制器已在跑(~/.trade-gate-okx/micro,BTC/ETH,1 分钟盘口 + 20 秒清算);盘口特征进 judge 标 live_only,历史回测拿不到,攒样本后走 G3 前向验证;fiapp 的 Jev 盘口预测已打分:92 条看不出区分度(样本太少,不下结论)
- [x] R12 可用 workflow → 已知悉,评测/复审阶段需要多代理交叉验证时再用
- [x] R13 网络:不换节点/IP → 已遵守;根因是本机一个跑了一个月的压测脚本(已停),线路仍约一半请求失败

09-25 04:20 Jacky 强调的验收重点与补齐项(现有组件约七成可复用,以下三成要新建,全部要做):
- [~] R14 雷达三档 = 短/中/长线信息来源:推荐已接(short←short、mid←swing、long←weekly,证据带雷达名次);策略运行的币池可绑定「雷达某档最新结果」动态刷新 → 待 astra 改完 strategy-run 后接
- [~] R15 组合级回测:finalist 释放留出段后做账户级回放(同 risk_pct / max_open / Jev 跟不跟 / 扣费),写进 finalist → Opus(matrix study)进行中
- [~] R16 出策略不出错 + 短/中/长线与来源标签:adopt 前跑运行预检,有 blocker 拒绝并说明;策略带 horizon + source → Opus 进行中
- [~] R17 分好的模型也能走完整条链(对话工具声明 + STRATEGY_LOOP_SKILL 已进对话系统提示;工具实现等 matrix study 服务;外部 agent 用的 skills/strategy-loop/SKILL.md 待路由定型后写):对话工具(开研究/查进度/adopt/切当前策略)+「策略研究」技能说明注入对话系统提示(任意底层模型按同一顺序调用)→ 本会话
- [ ] R18 角色真通信:研究完成/adopt 回调 → 往发起研究的对话推消息 + 写 handoff(下一步由它触发)→ 本会话,等 Opus 回调
- [ ] R20 前端信息架构:按新手上手顺序重排 tab、把放错地方的重要控件挪到位(例:OKX 账户模式藏在 Agent 页右栏「执行」tab 角落)→ 先出评估(子代理只读审计),等新功能落地后最后改
- [~] R19 回测与实盘对齐:运行器侧逐根移损/vol_target 定量/同币新信号/币池绑雷达已实现并对拍(704b820);runtime 接了 radarSymbols/openSized/reconcileOpen(4587f02);**待拍板**:vol_target 单笔止损风险是否仍受 risk_pct 上限(现为是 → 多数被拒);**待补**:移损账本 + 对账 + 各后端原子替换(现 placeProtection 不安全),未补前追踪止损在实盘只剩初始硬止损 + 机械离场;add/flip 执行链未做;3m/5m 不开放

- [ ] R21 评测闭环(复审 High-5):G1 CI 版通过(19 次研究 76s,只证明流程,不声明 FWER);**G1 正式版(1000×2 + 100 正对照,每路径 35 万根)估算约 190 小时单机**,今晚未跑——待定:缩短 fine_bars(如两年 15m≈7 万根)或并行/更强机器;另发现 fine_bars=350400 时 g1_no_trials_evaluated,需查。G2 推荐 as-of 缺时点资产池数据(UniverseStore 覆盖写),标 data_not_ready。G3 真跑约 $2 待批。
- [ ] R22 待拍板(复审 Critical-1):模型 API key 现存于 TS 网关(600 文件、不出明文);仓库 AGENTS「凭证只进 execd」本为交易所凭证而写 → 建议明确为交易所凭证只进 execd、模型 key 可在网关;若坚持迁 execd 属 XL 改动。

收尾(验收前必须做):
- [ ] E2E:18821/5201 验证实例(scripts/start-loop-dev.sh,paper)走通「对话 → 推荐卡 → 矩阵研究 → 迭代 → adopt → 设为当前策略 → 楼层显示」
- [ ] G1/G4/G5 离线评测跑通;G3 真跑前报价等 Jacky 批
- [ ] 便宜模型复审一轮 + astra 修复
- [ ] 合回 okx-devday 前通知 jacky-26(楼层 v4 在其上接),重启 18811 前先查有无进行中的研究任务
