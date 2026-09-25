# 策略一键运行(Strategy Run)设计 — 2026-09-24

> 契约 `docs/demo/v3-ui-contract.md` §9.51。前置阅读:`strategy-apply-spec-2026-09-23.md`(binding 编译)、`candidate-v0-2026-09-23.md`(影子候选)、`asp-market-2026-09-20.md`(发布器)。

## 0. 问题

今天从「我的策略」到 agent 真的下单要走:生命周期步进条点 backtested→paper→live(只改状态,不下单)→ 部署页签(只读预览)→「去实盘部署台操作」深链到旧策略库 → 那边的 StrategySpec 和研究台 IR 根本不是一个对象 → 结果什么都没接上。ASP 发布又是账户级的另一套开关。用户点了四五步,策略实际上一笔单都不会下。

## 1. 目标形态:一个按钮

策略详情页右上角一个主按钮 **「运行策略」**。点开是一张小卡(不是向导),所有字段都有缺省值,直接点「开始运行」即可:

| 字段 | 缺省 | 说明 |
|---|---|---|
| 运行方式 | 自动下单 | `auto` 代码按策略下单 / `agent` Agent 把关(模型只判做不做,不改价格)/ `confirm` 每笔我确认 / `signal_only` 只发信号不下单 |
| 市场 | 策略 IR 的 `order.market`,没有就现货 | `spot` / `perp`,杠杆取 IR,封顶 `BINDING_LEVERAGE_CAP` 与账户上限 |
| 盯哪些币 | 策略回测用的币 | 也可选「我的观察列表」或自己加;上限 30。IR 自带 `universe.screen` 时每根照样逐币过筛 |
| 每笔风险 | 工作流 `risk_pct` | 数量 = 权益 × risk% / 止损距离,之后照常过组合经理与风控闸 |
| 同时最多持仓 | 3 | 本运行的线程数上限 |
| 发布到 ASP | 有 ASP 身份时可勾 | 策略产出的规范化信号投给订阅者 |

卡片顶部一行写清「下单到:OKX 模拟盘 / 纸面 / OKX 实盘」。只有实盘通道才要求输入 `LIVE` 二次确认,其余一律一键。

点完立刻做一次「现在扫一遍」(用最近一根已收盘 K 线),卡片变成运行状态条:`运行中 · 1h · 盯 5 个币 · 下一根 14:00 UTC 收盘 · 今天 0 单`,下面是活动流(扫描了什么、谁命中、下单/跳过/被闸拒的原因)。暂停 / 停止 / 改参数都在这条上。

删掉的步骤:生命周期步进条不再是前置(运行时自动把研究状态推到 paper/live,发布时写 `published_listing_id`)、「去实盘部署台操作」深链、旧策略库 StrategySpec 这一层(运行直接吃研究台 IR 的编译结果,不写旧注册表)、ASP 那边单独找发布开关。没回测过也能跑,但卡片上黄字提示。

## 2. 执行语义(后端)

**一个运行 = 钉住一个版本的 IR。** 新版本不会自动接管;卡片提示「有新版本 v3,切换」,切换 = PATCH version,已开的线程按旧版本跑完。

**调度**:runner 自己有定时器(不挂在工作流 K 线上,因为策略周期可以比工作流快或慢),每 15 秒检查每个运行的周期边界,收盘后 +5s 触发;同一 (run, symbol, as_of) 只处理一次(落库去重,重启不重复下单)。尊重全局紧急停止 / 风控 halted / Executor 暂停。

**每根收盘、每个币**:
1. 拉 `viewBars+2` 根 K 线,调 `strategy-candidate.ts generateCandidates`(内部是 `irCandidate`,与研究回放同一函数)。单币同步计算 >200ms 的 IR 整个运行进 `error`,不拖垮网关。
2. 命中 → 记 `candidate` 事件;该币已有本运行的持仓/挂单 → `skip(already_open)`;超 `max_open` → `skip(max_open)`。
3. 按运行方式:
   - `auto`:走 `bookOpenFromSignal` 同一条组合经理路(抽出通用的 `bookOpenFromPlan`),`approval:'auto'`,不问模型。
   - `confirm`:同上,`approval:'manual'`,生成待批意图,人在交易页/审批里点。
   - `agent`:一次短模型调用,输入 = 候选几何 + 策略人话规则 + 该币行情摘要,输出只允许 `{follow|skip, reason}`,不能改任何价格;超时/解析失败 = skip。follow 后同 `auto`。计入现有模型额度闩。
   - `signal_only`:不下单,只发布。
4. 发布(`publish_asp`):候选本身作为规范化信号投递(见 §4)。

**持仓期(全部由代码)**:入场后止损/止盈照常挂交易所保护单。runner 每根收盘对本运行的开仓线程跑 `irExit`:信号离场 / 时间止损触发 → 走现有平仓路径并记 `exit` 事件;吊灯追踪只收紧,改止损走现有改保护单路径(若本轮接不上,在 unmapped 里标 warn,不假装支持)。这些线程**不进模型持仓复查**(spec §4.4:mechanical/filter 持仓期零模型)。

**方向**:候选生成目前 long-only(research/strategy.ts)。IR 要做空时预检直接 blocker「这条策略要做空,运行器暂只支持做多」,不近似。

**成交归属**:线程 `origin = strategy_run:<run_id>`,`strategy_id = rs_xxx@version`,平仓后追加一行运行统计(已实现 R、退出原因),为 §6 回流 live_stats 铺路。

## 3. 状态与生命周期联动

运行状态 `running | paused | stopped | error`。一个策略同时只允许一个非 stopped 的运行(再点「运行」= 编辑现有运行)。
- 开始运行且通道是 paper/模拟盘 → 研究状态低于 `paper` 时推到 `paper`;实盘 → 推到 `live`(用户已在卡片里输入过 LIVE)。
- 开了发布 → `published_listing_id = asp:<asp_agent_id>:<run_id>`,状态推到 `published`。
- 策略归档 → 其运行自动 stopped。

## 4. ASP 规范化信号

发布器新增事件类型 `strategy_signal`(候选即信号),payload 在现有 `renderDeliverable` 上加:
`strategy: {id, name, version, timeframe}`、`market: spot|perp`、`leverage`、`entry_type: next_open_market`、`valid_until = as_of + 一根周期`、`traded: boolean`(本账户是否跟着下单)。
`signal_type`:运行在纸面通道 → `analysis`(沿用「纸面只能 analysis」);`signal_only`、OKX 模拟盘或实盘 → `order`。本运行开出的线程后续 entry_filled / sl_hit / tp_hit / thread_closed 事件也带同一个 `strategy` 块,订阅者能把开平对上。买来的信号永不转发(不变)。
没有 ASP 身份时开关置灰,提示去「信号市场 → 发布」注册(链上注册不能一键)。

## 5. 还补了什么(验收外)

- **现在扫一遍**:开跑立刻出结果,用户不用等一根 4h 才知道活着。
- **活动流**讲人话:每条跳过/拒绝都有原因(闸名、已持仓、模型说不做)。
- **版本钉住 + 升级提示**,不会因为研究台改了 IR 让在跑的仓位语义漂移。
- **幂等**:(run, symbol, as_of) 去重,重启或双击不重复下单。
- **重 IR 保护**:单次计算超时自动停该运行并说明原因。
- **列表页**卡片上直接显示「运行中」胶囊和今天单数,点胶囊暂停。


## 6. 2026-09-24 第二轮实现修订

以上 long-only / 单目标 / next_open_market 的首轮范围由本节更新，字段名保持 §9.51 不变。

- 有 `order` 的 IR 走 `research/orders/intents.ts orderIntents`（内部调用 `resolveOrder`），复用研究核的信号上升沿、short/both 冲突处理、方向门、镜像价位、限价相对价格重锚、目标排序及比例口径。仅 spot 拒绝空头。持仓期信号退出走 `orderManager`，时间止损取 `resolveOrder.max_holding_bars`；无 order 的旧 IR 不改变候选口径。
- 已核对线程、holding、保护单及 `bookOpenFromSignal`：原 `tp_partial_unsupported` 的来源是只传第一档且原生 TP 为全仓，`reducePosition` 虽能按数量减仓，但没有多档自动触发/状态机。此次选择最小的第一档比例止盈：为纸面/OKX 原生保护接口增加指定数量 TP，CID 在请求前落库；与止损保持独立，TP 后余仓数量对账；现货按余仓重挂止损，新止损在发送前冻结 CID 并可从中断恢复，禁止未知回执生成第二档。后续档位记录在线程，预检 warning `targets_partial`。未扩展的 Binance 通道多档保持 blocker，避免全平替代。没有实现“所有档位均兑现”。
- 限价通过既有 `openThreadFromProposal` 做 tick 对齐、风控、审批和发送；期限固定在信号根收盘 + N 根，不从审批时间重新计时。复用 trader 的 `entry_expires_at` / `followCancelEntries`，但由 runner 自己调度，避开 trader 首发只告警开关和队列互等；确认撤单才记 skip，未知继续对账，迟到审批拒绝。
- 筛选使用研究引擎同一个 `buildUniverse` / `screenUniverse` / `passesUniverseScreen`，以运行币池等权作为市场因子。取 2162 根（默认 2160 回看，因子默认 720 根拟合要求至少 1440 个收益样本）；币池或样本不足不填值、不跨未来生成排名。
- 未实现的移动止损和同币新信号 replace/roll/add/flip 仍明确 warning；硬止损缺失、Pine、超窗高周期等继续 blocker，并给出用户操作办法。没有修改研究 binding 的 V0 子集约束，运行器只过滤自己已接通的能力提示。
