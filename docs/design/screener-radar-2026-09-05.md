# Radar 筛选器:在团队里的位置、节奏、成本与边界(2026-09-05)

> 回答 Jacky 的问题:「每 12 小时做一次资产 screen 找最好做的策略(12h 的是短线),再加一个更长周期的 screen 做中长线,这放在哪个环节?要不要单独一个 agent?」
> 答:单独一个角色,就是团队指南(`trading-swarm-bot-team-guide-2026-09-04.ipynb` §3/§4/§11.1)里的 **Radar / 信息与发现**。它是 Phase 2 落地的第一个真正的团队成员,也是 bot 注册表 / bot_runs / bot_handoffs 三张表的第一个真实写者。

## 1. 放在哪个环节

```
数据 → [Radar 筛选:12h 短线 / 72h 中线 / 7d 周线] → watch_candidates + WatchlistProposal
                                                   → handoff radar → gate_captain(kind=result)
                                                   → 人点「应用」(或 screener_apply=auto)只改 workflow.watchlist
watchlist → 代码触发器 / 心跳指纹 → Thread Manager(现有判断模块)→ WATCH / PROPOSE → 闸 → 执行
```

筛选**不是判断**:它决定「值得看哪几个币、哪条策略现在最贴」,不决定「买什么」。它的产物只影响 Thread Manager 的输入(watchlist),不接触风险、杠杆、执行后端、策略启用。这也是为什么它能用最便宜的模型、甚至不用模型。

三个周期对应三种时间尺度,同一套打分代码换周期跑:

| horizon | 节奏 | 打分周期 / 确认周期 | 前瞻期望回看 | 卡片有效期 |
|---|---|---|---|---|
| short(短线) | 12h(`screener_short_every_ms`) | 15m / 1h | 60 天 | 12h |
| swing(中线) | 72h(`screener_swing_every_ms`) | 4h / 1d | 180 天 | 72h |
| weekly(周线) | 固定 7d | 4h / 1d | 180 天 | 7d |

## 2. 确定性部分 vs 模型部分

**确定性(全部代码,`screener.ts`)**:宇宙解析(watchlist + 8794 白名单 / 24h 成交额前 N / 手填列表,上限 `screener_max_symbols`)→ 每币拉四条 K 线序列(打分周期 / 1h / 4h / 1d,走 backtest 的磁盘缓存)→ 机会卡 `OpportunityCard`(趋势一致性 + ADX、ATR% 与 90 根分位、布林带宽分位 / squeeze 根数、距 20 根突破位的 ATR 距离、资金费率 + 30 天 z、回归统计、日线状态、成交额名次)→ 对策略库里每条策略的 checklist 逐条判 pass / near / fail 得 `fit_score`(0..1)→ 可选每币×策略的机械前瞻期望(`screener_expectancy`,默认关,贵)→ 排序(契合度 → 机械期望 → 成交额)。

**模型(可选,`screener_use_brain`,一次便宜大脑调用)**:只对前 25 张卡做**重排 + 一句理由**。守卫:模型挑的币和策略必须已经在卡里;理由里任何 ≥3 位数字必须在卡片文本里逐字出现,否则整行丢弃(`guardBrainLines`,与记忆数字泄漏闸同款)。模型意见只影响排序,不新增币、不改分数。预算 ¥0.02/次;实测 GLM-5.3 一次约 ¥0.004–0.006。

**成本账**:短线每天 2 次、中线每 3 天 1 次、周线每周 1 次 ≈ 每周 17 次筛选,模型侧 < ¥0.1/周;K 线请求每币 4 条、60 币 240 条,有磁盘缓存后增量很小。

## 3. 编排层(`radar.ts`)与红线

- 定时器:三个周期各一个;开机 60 秒后跑到期的(从没跑过 = 到期);`workflow.paused` 或紧急停止时**整轮跳过**并记一条 `skipped` 的 bot_run(不调模型,也不打公共 REST),30 分钟后再看;`screener_enabled=false` 同样只等待。
- 手动「立即筛选」在暂停时允许,但 brain=null(只用确定性排名)。
- 每次筛选 = 一条 `demo_bot_run`(role radar,routine `screen:<horizon>`,budget 与实际 cost)+ 一条 `demo_screen` + N 条 `demo_watch_candidate` + 一条 `demo_bot_handoff`(radar → gate_captain,kind result,subject {type:'screen', id},幂等键 `screen:<id>:gate_captain:v1`,payload = 提案)+ 活动流 `screen_done` / `screen_failed` + SSE `screener.changed` / `bots.changed`。
- 「应用」= `proposalPatch()` → `rt.setWorkflow({ watchlist })`。这个函数的返回类型只有 `watchlist` 一个键;`screener_apply=auto` 也走同一条路,过了卡片有效期的提案自动应用会被拒。
- 角色边界:`demo_bot_profile` 里 `exchange.write` 有且只有 executor 持有;`DemoStore` 构造时 seed 并 `assertRoleBoundaries()`,手改一行 profile 进程就起不来。八个角色里这版 enabled 的只有 radar / thread_manager(现有判断模块)/ executor(现有执行后端),其余五个占位,note 写明差什么。
- bot-to-bot 文本是 untrusted data:handoff 的 ack 只表示「人看过了」,不构成授权。

## 4. 接口(细节在 `docs/demo/v3-ui-contract.md` §9.12)

`GET /api/screener/latest?horizon=` · `GET /api/screener/history` · `GET /api/screener/:id` · `POST /api/screener/run {horizon}`(202 / 409)· `POST /api/screener/:id/apply` · `GET /api/bots`(含代码推导的 presence)· `GET /api/bots/runs` · `GET /api/bots/handoffs?status=` · `POST /api/bots/handoffs/:id/ack`。前端:`#/screener` 页 + Agent 页「团队」卡(本仓库)、值班团队「作战楼层」(另一 session 在做,`docs/design/ops-floor-2026-09-05.md`)。

## 5. 这版没做、后面阶段要补

1. **候选 → 线程的自动衔接**:现在提案只改 watchlist,`active_strategies` 建议只是参考;下一步让 WatchCandidate 带 `wake` 条件进触发器(notebook §11.1「WATCH 应持久化为 WatchCandidate,含再唤醒条件和 TTL」)。
2. **筛选质量的证据**:候选卡在 TTL 内的真实表现(跟 `funnel.ts` 的机械期望对账)还没有回写;要有了才知道 fit_score 是否有预测力,以及模型重排是否比确定性排名好。
3. **宇宙扩展**:`top_volume` 现在按 24h 成交额;缺流动性 / 点差 / 强平流的维度。
4. **Gate Captain 收件箱**:handoff 目前只有 radar → gate_captain 一条边,gate_captain 本身还是占位;作战楼层先把「待阅 + 应用」做成人的收件箱。
5. **strategy_lab / reviewer 的 presence**:回测跑动与记忆反思应映射为 working,这版一律 off。
