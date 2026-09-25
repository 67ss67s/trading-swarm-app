# 策略研究 v3(执行器 / 无偏回放 / 自动轮换 / 减黑盒)+ 事件研究闭环(2026-09-12 下午)

Jacky 09-12 下午的要求,原话要点:agent 现在只跑 breakout_retest,其他策略都堵在策略模块里;要「找策略→回测→使用→复盘→升级」全自动且专业;上线策略切换给 agent 真跑;复盘时把判断准不准从策略里剥出来;每条策略自定义指标/事件,减少黑盒;事件区要像「昨天 PPI、今天 CPI、明天利率」的宏观日历,agent 自己查出发布时间,到点自动去拿一手信息,用户也能指派研究,agent 自己规划去做;新策略搬进来之前要有学术/实战支撑的研究方法,回测高效且无偏差。

## 0. 现状诊断(两份只读事实梳理 + 现网数据)

| 现象 | 根因 | 位置 |
|---|---|---|
| mtf_alignment 与 vol_compression 的 lab_stats 完全相同(2671 笔 −0.02R);swing 与 position 也相同 | Lab 漏斗只实现了突破回踩一族的 setup,其他族被当「粗代理」塞同一套参数;derivatives / mean_reversion 根本量不出 | strategy-lab.ts:62-68,228;funnel.ts |
| 所有 R 都是毛的 | outcome.ts 不扣手续费/滑点/资金费 | outcome.ts:65-70 |
| 探针「上下各一档挑最好」直接进 shadow 门 | 无样本外、无 walk-forward、无多重检验校正,trial_count 没记 | strategy-lab.ts:126-152,strategies.ts:837-853 |
| 回放币池 = 今天的 screener_whitelist | 幸存者偏差 | workflow.ts:65,strategy-lab.ts registerManifest |
| 限价成交用当根 high/low 判触及 | 用了这根未走完的极值,偏乐观 | backtest.ts:1044-1048 |
| 门槛全是硬编码经验值(n=20、0.1R、3R) | 不按族/波动率/样本置信区间 | strategies.ts:641-647,strategy-loop.ts:53-57 |
| 假设生成器 measurableByFunnel 只认三族 | 其余族的合理假设被丢 | strategy-hypothesis.ts:76,292-295 |
| 事件日历硬编码 9 条 FOMC/CPI/NFP | 无自动获取发布时间、无 PPI/PCE/GDP/失业金 | events-calendar.ts:40-53 |
| 简报「拿一手信息」不联网 | 只拼统计+快照喂便宜大脑 | runtime.ts:1190-1222 |
| 没有研究指派/自规划 | 模型面禁 WebFetch/WebSearch,无任务实体 | execution-agent.ts:39 |
| 事件不能成为开单依据 | 设计上事件区只读,只做证据/唤醒/封锁 | events.ts:11-12 |
| 判断账本只能等线上样本 | 没有离线回放三条腿 | judgment-ledger.ts |

## 1. 包划分与归属(文件所有权,避免撞车)

| 包 | 谁 | worktree / 分支 | 独占文件 |
|---|---|---|---|
| P1 策略执行器 + 无偏回放 + 判断回放 | 工作线 | `tg-wt-strategy-engine` / `wt/strategy-engine` | 新 `strategy-signals.ts`、新 `replay-stats.ts`、funnel.ts、strategy-lab.ts、outcome.ts、backtest.ts、strategy-hypothesis.ts、strategies.ts(只动 gate 常量段与 stats 类型)、migration **0019**、scripts/lab-*.mjs、对应测试 |
| P5 事件研究闭环 | 工作线 | `tg-wt-event-research` / `wt/event-research` | events.ts、events-calendar.ts、新 `calendar-feed.ts`、新 `research.ts`、routes-events.ts、info.ts、runtime.ts(只动事件/信息员段)、migration **0020**、webui `pages/events.tsx` + 新 research 组件、事件 SSE |
| P2 策略切换与自动轮换 | 主线 | `tg-wt-strategy-switch` / `wt/strategy-switch` | workflow.ts、strategy-council.ts、strategy-loop.ts(新增 allocator 段)、routes-strategies.ts(active/allocator 端点)、webui 策略页顶部切换区 + 设置页(议会/入场/探针队列开关)、migration **0021** |
| P3 自定义证据编辑器 + 减黑盒 | 主线 | `tg-wt-evidence-editor` / `wt/evidence-editor` | strategies.ts(只动 evidence 校验函数)、context.ts、routes-strategies.ts(`PUT /api/strategies/:id/evidence`)、routes-judgment.ts(证据来源明细)、webui 策略抽屉新组件 `EvidenceEditor.tsx`、判断记录页证据来源标记 |
| P6 收尾 | 工作线 | `tg-wt-closeout` / `wt/closeout` | 账本分页(routes-judgment.ts 分页参数 + 复盘页)、撤单退当日开仓额(runtime.ts 撤单段)、agent_mcp 限价 CID 回读比价(execution-agent.ts)、迁移 0016 重复编号处理方案(只写文档不改文件) |

主线只做合并、全量测试、重编 dist、交接。**三条铁律**:不 `git add -A`;不重启 18801(Jacky 放行才动);diff 只覆盖自己独占的文件,共用文件只改自己那一段、不重排不重格式化。

## 2. P1 策略执行器与无偏回放

### 2.1 目标
让每一条策略都能被**确定性地、独立地**量出来,并且量出来的数字经得起「学术/实战」的质疑:扣了成本、有样本外、对多重检验做了校正、不吃幸存者偏差、不偷看未来。这是「自动找策略→回测→晋升」的地基,没有它,自动化只是把噪声自动化。

### 2.2 策略执行器 `strategy-signals.ts`
- 注册表:`family → SignalFn`。`SignalFn(ctx: SignalContext) → Setup | null`,输入只有 `ctx.bars[tf]`(每个 tf 已按 `close_time ≤ T` 切好)、`ctx.params`、`ctx.derivatives`(funding/OI,取不到为 null)、`ctx.regime`。纯函数,不许 I/O。
- 五族各写一份确定性 setup:trend_continuation(现有 funnel 的 prior 突破口径搬过来)、mtf(触发周期突破 + 确认周期同向 + regime 不否决)、volatility(ATR/带宽分位 ≤ p20 持续 ≥ N 根后的首次释放;**跨 episode 状态**在 ctx 里带上,解决 09-12 遗留)、derivatives(funding z-score 极端 + OI 变化 + 方向结构确认;无 OI 历史时只用 funding,并把 `coverage` 写进 stats)、mean_reversion(regime=range、距边缘 ≤ 0.3 ATR、假突破收回、量能衰减)。
- 每个 setup 产出:方向、入场方式(market/limit + 参考价)、止损距离、止盈倍数、失效条件;结算沿用 outcome.ts。
- Lab 的漏斗 → 改成「按策略跑执行器」,lab_stats 每条策略独立;funnel.ts 的边际杀伤/放宽阶梯保留为 trend_continuation 族的诊断工具。
- `measurableByFunnel` → `measurable(spec)`:注册表里有该 family 且 checklist.required 的指标都能算就为真。

### 2.3 成本模型(outcome.ts)
- 手续费 taker 0.05% / maker 0.02%(可配),滑点按 `max(1 tick, k × ATR)` 且方向不利,资金费按持仓跨结算点次数 × 当时费率(历史费率已有接口;缺则用区间均值并标 `funding_estimated=true`)。
- 限价成交改保守:要求价格**穿过**限价 ≥ 1 tick(`low < limit` 而不是 `low ≤ limit`),或下一根开盘在限价不利侧才算成。
- 所有 stats 同时给 `gross` 与 `net`,晋升门只看 net。

### 2.4 无偏评估 `replay-stats.ts`
- **样本外**:anchored walk-forward,训练窗 60 天 / 测试窗 20 天滚动,参数探针只在训练窗选、测试窗记账;报告 `is_expectancy`、`oos_expectancy`、`oos_n`。
- **净化与禁区(purge/embargo)**:训练窗与测试窗之间空出 `horizon_bars` 根,防止一笔交易的结算跨窗泄漏(López de Prado, *Advances in Financial ML* ch.7)。
- **置信区间**:对每笔 R 做 bootstrap(≥1000 次)给 expectancy 95% CI;`n<30` 一律 `insufficient`。
- **多重检验**:每个 strategy family 记 `trial_count`(每次探针/每个候选参数 +1,失败也记),用 Deflated Sharpe Ratio(Bailey & López de Prado 2014)把 `oos` Sharpe 按 trial_count 折扣;报告 `dsr`;探针不许「上下各一档挑最好就晋」,只有 `dsr > 0` 且 OOS CI 下界 > 0 才能提 createVersion。
- **幸存者偏差**:回放币池按「区间起点时已上市 ≥ 30 天且当时 30 天成交额进前 N」选,不用今天的 whitelist;上市时间用该币最早 K 线 open_time;把 `universe_rule` 写进 manifest。
- **前视**:沿用 `assertBlind`,新增执行器输出的 setup 时间戳断言。
- **regime 分层**:stats 按 daily regime(trend/range/high_vol)分桶,门槛检查「不是只在某一 regime 赚」(至少两桶 net 期望 ≥ 0)。
- 效率:K 线磁盘缓存已有;执行器是纯函数,可以对同一批 bars 跑多组参数;目标 18 币 × 90 天 × 5 族 < 60 s。

### 2.5 门槛改造(strategies.ts gate 段)
- backtest → shadow:`oos_n ≥ 30`、`oos_net_expectancy` CI 下界 > 0、`dsr > 0`、≥ 2 个 regime 桶非负、`max_dd_r ≤ 3`。
- shadow → paper:沿用 09-12 四条,但 expectancy 用 **net** 且与 lab 差用 OOS 值比。
- 降级:沿用,期望改 net。
- 门槛常量集中成 `PROMOTION_POLICY` 一处,支持按 family 覆盖;每次门判都把「差多少」写进 strategy_events(前端「离 paper 还差多少」直接读)。

### 2.6 判断回放三条腿(backtest.ts)
- 回放模式加 `legs: ('model'|'council'|'mechanical')[]`:council 腿 = 执行器对当时 active 策略的共识(零模型),mechanical 腿 = 现有 mechanicalFor;model 腿 = 现有 judgeOnce(付费)。三条腿同一快照、同一 horizon、同一成本模型结算,按 judgment-ledger 的行格式写 `demo_judgment_ledger`(标 `source='replay'`,不与线上行混)。
- 这样「模型判断到底准不准(剥离策略)」不用等线上样本:council/mechanical 两条腿零成本随时跑,model 腿只在改 prompt 时跑。

### 2.7 交付物
- 代码 + vitest(每族 setup 至少 3 个正例 3 个反例;成本模型;walk-forward 切窗;bootstrap CI;DSR;universe 选择;保守限价成交);`npm run lab` 一条命令跑全策略并打印表;`docs/design/strategy-engine-v3-2026-09-12.md`(方法、公式、引用、与线上一致/不一致的边界);契约 `docs/demo/v3-ui-contract.md` §9.32(lab_stats 新字段:oos/net/ci/dsr/trial_count/regime 桶/universe_rule)。
- 学术依据(已在 docs/research/strategy-construction-2026-09-05.md 列出):Bailey & López de Prado *Deflated Sharpe Ratio*;White *Reality Check*;López de Prado *AFML*(purged CV / embargo / backtest overfitting);Pardo *walk-forward*;Harris *Trading and Exchanges*(成本)。

## 3. P5 事件研究闭环

### 3.1 目标
Jacky 的画面:事件页像一张宏观日历——昨天 PPI、今天 CPI、明天利率决议;agent **自己**查出发布时间并核对;到点自动去拿一手数据(实际值 vs 预期);用户能指派「研究 X」,agent 自己规划来源、抓取、提炼、写成简报,简报进证据,复盘回填影响;事件能作为议会里的一票(通过 P1 的 event_driven 族,本包只留接口)。

### 3.2 自动日历 `calendar-feed.ts`
- 源(服务端 fetch,走 env 代理,回环在 NO_PROXY):公开周历 JSON(ForexFactory `nfs.faireconomy.media/ff_calendar_thisweek.json` 类)、BLS 发布日程页、美联储 FOMC 日历页;解析成 `MarketEvent(kind='scheduled')`,覆盖 FOMC / CPI / PPI / NFP / PCE / GDP / 初请 / 零售,含 `consensus`、`previous`、`importance`。
- 两源一致 → `confirmed`;单源 → `reported`;冲突 → 告警 `calendar_conflict` 并保留两个时间。每周刷新一次 + 事件前 24h 再核一次。`CALENDAR_2026` 静态表降级为兜底。
- 全部 UTC 存,前端按本地显示。

### 3.3 研究任务 `research.ts`(harness loop,零 WebSearch,只用服务端 fetch + 域名白名单)
```
ResearchTask { id; kind: 'event_prep'|'event_release'|'topic'|'calendar_refresh';
  event_id?; topic?; assigned_by: 'agent'|'user'; due_at; status: 'planned'|'running'|'done'|'failed'|'cancelled';
  plan: { sources: {url, why}[], questions: string[] };   // 便宜大脑 1 次
  fetches: { url, at, ok, bytes, excerpt_ref }[];         // 服务端抓,每任务 ≤ 6 次,单页 ≤ 200 KB 正文
  findings: { claim, value?, refs[], confidence }[];       // 便宜大脑 1 次做结构化提炼
  brief: string | null; cost; created_at; finished_at }
```
- 自动创建:scheduled 事件 T−24h 建 `event_prep`(拿预期值、上次值、市场定价);T0+2min 建 `event_release`(拿实际值:BLS API v2 时间序列 CPI `CUUR0000SA0` / PPI `WPUFD4` / NFP `CES0000000001`,Fed 声明页;算 surprise = actual − consensus)。
- 用户指派:`POST /api/research {kind:'topic', topic, due_at?}` + 事件页/详情抽屉「指派研究」按钮;agent 规划计划后可在 UI 看到并取消。
- 白名单:bls.gov / federalreserve.gov / bea.gov / treasury.gov / binance.com 公告 / coindesk / cointelegraph / theblock / faireconomy;不在白名单的 URL 直接拒。
- 预算:每天研究模型调用 ≤ 20 次、fetch ≤ 100 次(workflow 键 `research_daily_cap`),满了排队到次日;失败重试 1 次。
- 产出:brief 写回事件 `briefs[]`(替换今天只拼统计那版);`event_release` 的 findings 写 `event.actual/consensus/surprise`;进证据时标 `source='research'` 与 refs,判断记录里可点开。
- 复盘:impact 回填后把 `surprise → move_4h` 的样本累积到 subkind 统计(为 event_driven 策略族备料)。

### 3.4 事件页
- 顶部日历带(昨天/今天/明天/本周),每格:名称、发布时间(本地)、预期/上次/实际、surprise、研究状态徽章。
- 「指派研究」入口(事件级 + 自由主题);研究任务列表页签(计划/抓取/结论/花费);SSE 推送(复用 `/api/events` 通道加 `market_event` / `research_task` 两种消息),去掉 30 s 轮询。

### 3.5 边界
- 模型仍然不能直接下单;事件成为票的路径只留 `SignalFn` 接口给 P1 的 event_driven 族。
- 不给模型 WebSearch;所有抓取是服务端确定性代码按计划里的 URL 做,计划本身由便宜大脑出、由白名单过滤。

## 4. P2 策略切换与自动轮换(工作线,等复审「多策略轮换后端还缺什么」清单出来后再派)
- `workflow.active_mode: 'manual'|'auto'`。auto 下 allocator 每天一次:候选 = paper+ 策略;按 regime 分桶取最近 30 天 net 期望(P1 字段)排名,选前 `active_strategies_max` 条且每族最多 1 条;变更写 strategy_events 与告警 `active_set_changed`(info)。
- 在途线程钉 `strategy_refs` 不受影响(已有);退化自动移出(已有)。
- 前端:策略页顶部「当前票池」加「手动/自动」切换、每条为什么在/不在票池的一句话(读 strategy_events);设置页补议会/入场/探针队列开关。
- 不做:让模型选票池。

## 5. P3 自定义证据编辑器 + 减黑盒
- `PUT /api/strategies/:id/evidence`:校验 indicators id ⊆ INDICATOR_SETS、tf 合法、events ⊆ TriggerKind;写成新版本 draft(evidence 进 hash,所以必须走 createVersion),不改旧版本。
- 编辑器:指标库多选(按分类分组、按 tf 分列)、事件多选、info_topics 输入;保存即出草稿并跳到时间线。
- 减黑盒:判断记录页每条证据标 `required_by` 与来源(indicator/event/research/news);「模型看到了什么」= 当时 evidencePlan 的快照存进 episode(新增 `evidence_plan_hash` + 明细),前端可展开。

## 6. P6 收尾
- 判断账本分页(`?limit&cursor`,复盘页「加载更多」)。
- 撤单成功(零成交且终态)退当日开仓额(09-09 待办④),带用例。
- agent_mcp 限价发单后按 CID 回读一次比对 price,不一致告警(09-09 待办⑤)。
- 迁移 0016 重复编号:只写 `docs/handoff` 里的处理建议,不改文件。

## 7. 顺序
1. 现在:P1、P5、P3、P6 分派;四个 worktree 并行。
2. 合并复审报告落地后:派 P2。
3. 逐包:tester 全量 vitest + tsc → 主线合并 → dist 重编 → 交接;对抗复审一次(合并后)。
4. 重启 18801 由 Jacky 放行。
