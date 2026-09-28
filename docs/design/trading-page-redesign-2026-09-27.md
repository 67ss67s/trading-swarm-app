# 交易页重新设计 · 功能设计(第 1 步)

2026-09-27 · 分支 wt/trading-sources · 状态:定稿 = 布局 B(故事式),Jacky 09-27 选定;§7 四件事已拍板;实施计划见 §10

这一版只定功能:页面替用户回答什么问题、每块放什么不放什么、默认看到什么、点开才看到什么、几块之间怎么连。长什么样放到第 2 步的可点击 demo 里比。

## 0. 这次为什么重来

现在的页面是把「三层模型」直接画了出来:顶上一串 ①②③ 标签,左栏每张来源卡把漏斗、判断方式、被挡原因、今日没做全摊开,手动下单被挤成左栏底部的折叠条,线程单独占一栏,右边五个 tab(图表 / 线程 / Jev / Agent / 风控)。结果是三层模型用户记住了,但「现在谁在帮我交易、我自己怎么下一单」反而找不到。

这版的思路反过来:先定用户来这页要问的六个问题,每个问题给一个固定的地方回答;三层模型只作为这些回答背后的结构,不再单独画成一条标签链。

## 1. 页面要回答的六个问题

| # | 用户的问题 | 在哪回答 | 一眼能看到的答案(例) |
|---|---|---|---|
| Q1 | 现在谁在帮我交易? | 来源列表 | 「AI Scan 在跑 · 1 个策略已暂停 · 你自己」 |
| Q2 | 今天做了什么、没做什么? | 来源列表每行的今日计数 + 状态行 | 「AI Scan 看了 359 次 → 提议 3 → 下单 1」 |
| Q3 | 为什么没下单? | 来源行上的红色被挡数 → 来源详情 | 「2 笔被挡:执行出错 2」,点开看原文 |
| Q4 | 我的风控规则是什么? | 状态行里的规则摘要 + 下单面板的规则参考 + 规则面板 | 「每笔 0.5% · 3x · 止损 0.3–5% 且 ≥0.5 ATR · 盈亏比 ≥1.5 · 持仓 1/5 · 今日 1/10 · 日亏 3% 停」 |
| Q5 | 我自己怎么下一单? | 图表右侧常驻下单面板 | 一直在,不用找 |
| Q6 | 持仓怎么样? | 图表下方的线程表 | HYPE 多 · 来自 AI Scan · 浮盈 · 止损 92.99 / 止盈 94.88 |

每个问题只有一个主回答处。别的地方可以链过去,但不重复摊一遍。

## 2. 用户需要懂的概念,只留三个

1. **来源(Sources)**:谁在找机会、谁来决定做不做。AI Scan、每条策略运行、还有「你自己(Manual)」都是来源。**判断方式是来源的一个属性**(AI Scan 固定是模型判断;策略运行可选 Direct / Jev / LLM / Signal only;Manual 是你自己判断),不再单独当成一层画出来。
2. **规则(Rules)**:代码执行的统一风控。AI Scan 和策略运行下单前过全套;**手动单只过容量类**(急停/暂停、同币只开一条、持仓数、今日次数、日亏停、事件封锁),止损距离、ATR、净盈亏比对手动单不拦(Jacky 09-27 拍板)。这就是原来的「③ 风控与执行」,对外叫 Rules。
3. **线程(Threads)**:过了规则、真的发出去的单子,以及它们现在的状态。名字不改,还叫线程(Jacky 09-27 拍板),界面英文仍是 Thread。

页面上只在一个地方用一句话把三者串起来(状态行下的一行小字或首次访问的一次性提示):

> Sources find trades → each source decides (or you decide) → Rules check the order → Threads.

这是一行静态说明,不是弹窗,和评审版新手引导不抢(见 §6)。

## 3. 区域设计

页面分五块:状态行、来源列表、图表、下单面板、线程表;规则面板和详情都是点开才出来的抽屉,不占常驻位置。具体摆法第 2 步出 2–3 种布局比,下面只定每块的内容。

### 3.1 状态行(顶部,一行)

放:
- 执行通道徽章:Paper / OKX Demo / Live(真钱红色)。评审版固定显示 `Paper · Judge demo`。
- 一句话现状:`2 sources on · 1 open thread · 1/10 opened today`。
- 规则摘要(可点,打开规则面板):`Rules: 0.5% risk · 3x · stop ≥0.3% & ≥0.5 ATR · R:R ≥1.5 · max 5 open · 10/day · stop at −3% day`。
- 异常状态,只在发生时出现:急停、全部暂停、日亏停(红/黄底,写清「到明天前不开新仓」这类后果)。

不放:①②③ 标签链、各来源名字、Agent 当前策略胶囊、额度花费。

### 3.2 来源列表(回答 Q1–Q3)

一行一个来源,紧凑,行高固定。每行:

```
● AI Scan          AI model decides      359 looked → 3 proposed → 1 order    2 blocked
● Multi-TF align   Signal only · paused  9 scans → 0 candidates                —
● You (Manual)     you decide            1 order today                          —
```

- 状态点:绿=在跑,灰=暂停/停止,黄=到了上限(持仓满、今日次数满)在等,红=出错或被日亏停挡住。
- 名字 + 判断方式(一个短词)。
- 今日一句漏斗:AI Scan 是「看了几次 → 提议 → 下单」;策略运行是「扫描 → 候选 → 判断跟了几个 → 下单」;Signal only 是「扫描 → 发出几条信号」。只放三到四个数,用箭头连,不画条形漏斗。
- 被挡数,红色,只统计真的被挡(`top_reasons` 里算被挡的那些)。0 就不显示。「模型判断不做」「观察」「临时失败已重试」不算被挡,不标红。
- 行尾一个 `⋯`:暂停/继续、改判断方式。

点一行 → 右侧抽屉(来源详情),内容按顺序:
1. 这个来源在干嘛,一句话:「Scans 23 symbols on 15m with the breakout-retest playbook; the model decides each trade.」策略运行写品种、周期、方向、版本、判断方式、执行通道。
2. 今日漏斗(完整版,各层数字)。
3. **为什么没下单**,按层分组:判断没跟 / 运行自己的上限 / 规则挡了 / 执行出错,每组列原因 + 次数 + 一条原文例子(`example`)。规则挡的原因能链到规则面板对应那一条(比如「止损小于 0.5 ATR ×7」→ 规则面板高亮 ATR 那行)。止损类原因的「怎么改」只说放宽策略止损或挪止损价,不引导调低规则下限。
4. 没做但不算被挡的(`not_taken`),默认折叠。
5. 这个来源今天的线程(过滤后的线程表)。
6. Jev 判断记录(只有 jev 模式的运行有)——原来的 Jev tab 挪到这里。
7. 链接:策略 → 我的策略 / 回测报告;AI Scan → playbook 说明。回测对比后续加在这里。
8. 操作:暂停/继续、判断方式切换(说明每种方式是什么:Direct 候选直接下单 / Jev 先问 Jev / LLM 先问模型 / Signal only 只发信号不下单)。

Manual 那一行点开:今天你下的单 + 被容量规则挡掉的手动单(如果有)。

不放在行上:漏斗条、判断方式下拉、被挡原因列表、今日没做列表、预算额度。

名字:来源列表、线程表的「来源」列、来源详情标题,三处用同一套短名(AI Scan / 策略运行名 / Manual / External),由同一个函数给出,不各写各的。

排序:在跑的在前;Manual 固定最后一行。停了且今天没事件的运行不显示(接口本来就不返回)。

### 3.3 图表

放:当前币种 K 线,入场/止损/止盈线(选中交易时),日线状态徽章。币种切换和下单面板、线程表联动:点线程表一行 → 图表切到那个币并画出这笔的线;下单面板改币 → 图表跟着变。

右上那排 tab(图表 / 线程 / Jev / Agent / 风控)拿不拿掉,Jacky 要看 demo 效果再定(§7 Q-D)。拿掉的话四个 tab 分别去线程详情抽屉、来源详情、全局 Agent 抽屉、规则面板;demo 里两种都做出来对比。

### 3.4 下单面板(回答 Q5,常驻,不折叠)

位置固定在图表旁边,和交易所一样。评委和用户最先想试的就是这里。

字段从上到下:
- 市场(永续/现货)、币种(和图表联动)、现价。
- 方向:Long / Short(现货是 Buy / Sell)。
- 类型:Market / Limit(+价格)。
- **止损**(永续必填)、止盈(选填)。止损旁边直接显示:`Stop 0.64% · ≈0.6× 1h ATR · loses ≈ 3.4 USDT at stop`(ATR 周期跟规则里的 `stop_floor_atr_tf`;亏损按保证金 × 杠杆算出的数量)。
- **仓位:保证金 + 杠杆**(Jacky 拍板,保持现在的写法,不按名义、不按风险)。杠杆默认取规则里的杠杆。下面一行小字算给用户看:`≈ 74.6 HYPE · notional 6,979 USDT · loses ≈ 42 USDT at stop (0.4% of equity)`。只是换算,不改数量。
- **规则参考**,输入时实时更新,分两组,样子上就区分开:

```
Before you send                      ← 这组会拦,不过就不能提交
✓ No open HYPE thread
✓ Open threads 1 / 5
✓ Opened today 1 / 10
✓ Daily loss −0.4% (stops at −3%)

For reference · AI Scan and strategies must meet these   ← 这组只提示
· Stop 0.64% ≈ 0.6× 1h ATR — rule ≥ 1%      (ATR 模式时:rule ≥ 1× 1h ATR ≈ 1.10%)
· Stop 0.64% — max 5%
· Net R:R 2.81 after fees — rule ≥ 1.5
```

  上面一组是真检查,没过就是红叉、提交按钮置灰、写原因(「HYPE already has an open thread」)。下面一组是参考,用灰色中性样式,不用红叉绿勾,标题直接写明是给自动来源的;没达到时变成琥珀色一句话(「Tighter than what the bots may use. Consider a wider stop.」),不提「会被拦」,也不引导去调低规则。
- 提交按钮文案带方向和币:`Long HYPE`。

ATR 用哪根:跟规则里的止损底线设置走——ATR 模式用 `stop_floor_atr_tf`(如 1h),百分比模式也按同一个周期显示「≈几倍 ATR」方便对照。数字取 `GET /api/execution-policy` 的 `stop_conversions[].atr_pct`(后端算好),不在前端再算;接口还没给到某个币时,退回用 `GET /api/market/klines` 按工作周期算 ATR14。规则数值一律从接口读,不写死。

### 3.5 线程表(回答 Q6)

把现在的「策略线程」栏和底部「账户 · 持仓/挂单」合成一张表,放在图表下方(合不合、和右栏 tab 一起在 demo 里看效果)。tab:

- **Open**:持仓中 + 等入场,一行一笔。列:币种、方向、**来源**(和来源列表同一套短名)、状态(Holding / Waiting entry / Needs attention)、入场、现价、浮盈 R 和 USDT、止损、止盈、操作(平仓/撤单)。需要处理的排最上面、行首红点。
- **Orders**:交易所挂单,含提交结果未知的入场单。
- **Closed today**:今天结束的,带结果(R、原因)。更早的链到复盘页。
- 没有线程对应的外部持仓也在 Open 里,来源写 `External`。

点一行 → 右侧抽屉(线程详情):论点、失效条件、盯什么、入场/止损/止盈、止损尺度(几倍 ATR)、判断记录(Jev/模型结论)、复查记录、订单编号。(如果右栏 tab 拿掉,原来的「线程」tab 就挪到这里。)

表上方一个来源过滤(All / 各来源),和来源列表点选联动。

### 3.6 规则面板(回答 Q4,点开的抽屉)

入口三个:状态行的规则摘要、下单面板规则参考的最后一行、来源详情里被规则挡的原因。

内容:
- 按用途分三组,每行「名字 · 当前值 · 今天用了多少 · 可调范围」:
  - Position size:每笔风险、杠杆、保证金模式、自动仓位(组合经理倍率:关/只建议/采用)。
  - Stop & target:止损底线、止损上限 %、净盈亏比下限。止损底线可切两种模式(Jacky 09-27),二选一、不取更严,`floor_pct` 按当前模式算:「百分比」(默认,底线 1%)和「ATR」(倍数 + 周期,如 1× 1h ATR)。ATR 模式下实时列出观察列表每个币的换算(1× 1h ATR ≈ BTC 0.55% / ETH 0.80% / SOL 1.10%),旁边一句「AI Scan 和策略按风险定仓位,止损宽了数量变小,打到止损亏的固定是权益 × 每笔风险(≈ 50 USDT)」。字段:`stop_floor_mode`、`stop_floor_atr_tf`、`min_stop_atr`、`stop_conversions[]`、`risk_per_trade_usdt`(后端 jacky-31 在做,以契约 §9.56 为准)。
  - Limits:同时持仓上限、每日开仓次数、日亏停。同币只开一条是固定规则,只展示不给改。
- 每行一句人话解释,比如 ATR 下限:「Stop must be at least this many ATRs away, so normal noise doesn't hit it. Wider on volatile coins.」
- 今日用量用细进度条:持仓 1/5、今日 1/10、日亏 −0.4%/−3%。
- 改完点 Save,只提交改过的键;实盘要再确认一次(`confirm: LIVE`)。
- 「Ask the agent to tune these」:打开 Agent 抽屉并预填当前规则和今天各来源被挡情况。agent 在直改区间内的改动直接生效,超出的生成提议卡,在面板顶部显示「Agent proposes: min stop 0.3% → 0.5%  [Apply] [Dismiss]」。
- 一行说明:「AI Scan and strategy runs must pass all of these. Your own orders are checked against the limits only; stop and R:R rules are shown as a reference.」

不放:回测数据、策略参数(那是策略自己的事)。

### 3.6b Playbook(AI Scan 的操作手册)

playbook 是 `workflow.playbook_text` 那段文字,告诉 AI Scan 什么时候做、怎么入场、止损止盈放哪、什么时候不做、持仓怎么管。

和策略的关系,在 AI Scan 详情里用一句话讲清:
- playbook 只管 AI Scan。
- 策略运行是并行的独立来源,按各自的策略规则扫描,不读 playbook。
- 设置了「Agent 当前策略」时,AI Scan 不再开新仓,只照看已有线程。
- 不管哪个来源,下单前都过同一套规则。

入口:AI Scan 来源详情里的「Playbook」,来源列表里 AI Scan 名字旁一个小链接。打开是阅读视图(抽屉或弹层):
- 顶部一句:「This playbook only guides AI Scan. Strategy runs follow their own rules. Every source still goes through the same Rules.」
- 按块排版:什么时候做 / 怎么入场 / 止损和止盈 / 什么时候不做 / 持仓怎么管。前端按每行开头的关键词分块(适用、日线状态、交易时段 → 什么时候做;入场、不追、急拉急跌 → 怎么入场;止损、失效 → 止损和止盈;NO_TRADE → 什么时候不做;有持仓时、挂单等待中 → 持仓怎么管),认不出的放「其它」,一条都认不出就原样显示。
- 关键数字高亮(1.5 ATR、0.05%、量比 ≥ 1.0 这类)。
- 评审版显示英文。英文来源(jacky-31 09-27 定):后端给默认 playbook 配一份固定英文译文,只用于显示,模型提示仍用原文;用户改过的 playbook 原样显示、不翻译。默认 playbook 在中文界面给英文 / 中文原文切换。

### 3.7 Agent

不再是交易页的一个 tab。页面右上角一个 `Ask agent` 按钮,打开右侧对话抽屉;规则面板的「让 agent 调」、线程详情的「问 agent 这笔怎么看」都打开同一个抽屉并预填问题。

## 4. 默认显示 vs 点开才看

默认(不点任何东西):状态行、来源列表(每行一句)、图表、下单面板和规则参考、线程表 Open tab。

点开才看:来源详情(漏斗全貌、被挡原因分组、Jev 记录、链接)、线程详情(论点、复查、订单号)、规则面板(全部参数、编辑、agent 提议)、Agent 对话、线程表其它 tab。

一个判断标准:默认层只放「数字 + 状态」,「原因 + 原文 + 操作」都在点开层。

## 5. 几块之间怎么连

```
来源列表 ──点一行──▶ 来源详情 ──被规则挡的原因──▶ 规则面板(高亮对应那条)
   │                    └──这个来源的线程──▶ 线程表(按来源过滤)
   └──点选──▶ 线程表按来源过滤

下单面板 ──币种──▶ 图表 ◀──点一行── 线程表 ──▶ 线程详情
   └──规则参考──▶ 规则面板
   └──提交成功──▶ 线程表 Open 多一行(来源 Manual),Manual 行计数 +1
                  容量类没过──▶ 提交前就置灰,写原因

规则面板 ──Ask agent──▶ Agent 抽屉 ──提议──▶ 规则面板顶部提议卡
```

## 6. 评审版差异(英文、Paper · Judge demo)

评审版全英文,文案按「评委第一次看、没人讲解」来写,少用 gate、episode 这类内部词(用 rule、scan);thread 保留,首次出现处给一句解释「A thread is one trade from entry to exit.」

访客能做什么,按 `public-gate.ts` 的放行表(不是全只读):

- **能**:手动下 paper 单、平 paper 仓/撤单、暂停/继续/停止策略运行、改运行的判断方式、恢复 AI Scan、和 agent 对话。
- **不能**:改规则(规则面板只读,Save 换成一行 `Owner-only in the demo`,保留查看)、暂停 AI Scan(全站共用,菜单里这项置灰写原因)、让 agent 改规则(`Ask agent to tune` 在评审版改成只问不改的文案)、任何 live。

所以评审版的下单面板正常可用,这是评委最能玩的地方;规则参考照常显示。

新手引导(`components/tour/judge-tour.tsx` + `steps.ts`,只在评审版):首次访问自动弹,顶栏有 Tour 按钮能重开。新布局要保证:
- 顶栏 Tour 按钮不动。
- 「trade」那一步现在依次找 `[data-tour="trade-runs"]` 和 `[data-testid="trade-context-bar"]`。新布局把 `data-tour="trade-runs"` 放在来源列表上,状态行保留 `data-testid="trade-context-bar"` 作为退路。
- 那一步现在的文案说「Four candidates trading on paper ... Open any of them in My Strategies to pause or resume it」,新布局下可以直接在来源列表暂停/恢复,文案要跟着改成指向来源列表,例:「These are the sources trading for you on paper: the AI scan and four strategy runs. Click one to see what it did today and why it skipped trades. Try your own order on the right.」改文案在评审分支合并时做,本分支不碰 wt/judge-release。
- §2 那行三者关系的说明是静态文字,不弹窗,引导不会和它抢焦点。


状态行固定 `Paper · Judge demo`,旁边一个小问号解释「Orders are simulated. Nothing touches real money.」

## 7. 已定(Jacky 09-27)

- **Q-A 手动单不过止损/ATR/盈亏比**,后端保持现状,只过容量类。下单面板显示这三条时只能是参考,不暗示会被拦(§3.4)。不加 preview 接口,ATR 前端用现有 K 线接口算。
- **Q-B 仓位按保证金 + 杠杆**,不按名义,也不默认按风险。风险金额只作换算显示。
- **Q-C 还叫线程**,不改名 Trade。
- **Q-D 右上 tab(图表 / 线程 / Jev / Agent / 风控)拿不拿掉**,demo 里给两种效果,Jacky 看了再定。
- jacky-31 补充:来源短名三处一致;止损类「怎么改」只引导放宽策略止损或挪止损价;评审版引导的 Tour 按钮和 trade 那步定位要保住(§6)。

## 8. 数据来源

- 状态行:`GET /api/execution-policy`(通道、values、usage)+ `/api/trading/sources` 的 `shared`(halted/paused/daily_loss_hit)。
- 来源列表和详情:`GET /api/trading/sources`(today、top_reasons、not_taken、last_event);操作 `PATCH /api/strategy-runs/:id`、`PATCH /api/trading/sources/ai_scan`;Jev 记录沿用现在 JudgeLiveFeed 的接口。
- 下单面板:`/api/symbols`、overview 行情和权益、`POST /api/orders`;规则参考用 `GET /api/execution-policy` 的阈值 + `GET /api/market/klines`(工作周期)前端算 ATR14。不加后端接口。
- 线程表:`/api/threads?status=open|all`、`/api/positions`、`/api/orders/open`。
- 规则面板:`GET/PATCH /api/execution-policy`;agent 提议沿用 WorkflowProposal。

第 2 步 demo 的假数据直接抓 18821 的真实返回(上面这些接口都已经确认形状)。

## 9. 第 2 步 demo

三种可点击布局,内容都按上面,区别只在摆法;每种都能切「右上 tab 保留 / 拿掉」两种效果(Q-D):

- **A 交易所式**:左来源列表(窄)、中图表、右下单面板,底部线程表。熟悉交易所的人一眼会用。
- **B 故事式**:顶部一条来源横排(每个来源一张小卡,Manual 也在里面)讲「谁在帮你交易」,下面图表 + 下单面板,底部线程表。更适合评委第一次看。
- **C 双视图**:一个开关在「Autopilot」(来源和线程为主,图表缩小)和「Manual」(图表和下单面板为主)之间切换,同一套数据。

每个 demo 都能走通三条路径:第一次打开看懂谁在交易;自己下一单,看到止损比规则参考偏近的提示、改宽后提交,线程表多一行;查 AI Scan 为什么今天只下了一单。

## 定稿:布局 B(09-27)

Jacky 看完三种 demo 选了 B:顶部「Who is trading for you」一排来源卡(Manual 在最后),下面图表 + 常驻下单面板,底部线程表。demo:https://claude.ai/artifact/55UKhB5LaAfyTBtNagJ47D(第 2 版)。

定稿时顺手改掉的:
- 来源卡多了自动换行(按宽度自适应列数),不横向滚动;窄屏两列、再窄一列。
- 线程详情的「≈几倍 ATR」和下单面板统一:按规则里的 `stop_floor_atr_tf`,数字取 `stop_conversions[].atr_pct`。
- 右上 tab 先按 demo 默认「拿掉」做:线程详情、Jev、规则、Agent 都走右侧抽屉。Jacky 有意见再改。

## 10. 实施计划(待 jacky-31 审)

只动 `packages/webui`。不碰 `packages/gateway`、`docs/demo/v3-ui-contract.md`(Codex 在审后端,工作区有它没提交的改动)。

### 第 0 块:底座(我,先做,串行)
- `api/trading.ts`:按 §9.56.2 / 9.56.11 补字段:`stop_floor_mode`、`stop_floor_atr_tf`、`stop_conversions[]`(可能是 null)、`stop_conversions_as_of`、`stop_conversions_stale`、`risk_per_trade_usdt`(字符串,可能 null)。PATCH 类型带上两个新键。
- `components/trade/story-logic.ts`:把 demo 的 `shared.js` 搬成有类型的纯函数:来源短名(来源卡、线程表来源列、详情标题三处同一个函数)、今日一句漏斗、被挡数 / 错误数、止损底线(`floorPct` / `floorLabel` / 取 `stop_conversions` 的 ATR%)、手动单两组检查(容量类会拦,止损/ATR/盈亏比只做参考)、仓位换算(保证金 × 杠杆 → 数量、名义、打到止损亏多少)、规则摘要、playbook 分块和数字高亮。配单测 `test/trade-story.test.ts`。
- i18n:每块一个英文词条文件 `components/trade/i18n/{sources,ticket,rules,threads,shell}.ts`,我先建好空文件并在 `components/trade/i18n-en.ts` 里展开,后面各块只改自己的词条文件,不会撞车。
- 每块组件的 props 接口先写成类型放在 `story-logic.ts` 里,子代理照着实现,我最后接线。

### 第 1 块:四个子代理并行(opus 写码,文件不重叠)
| 块 | 新文件 | 内容 |
|---|---|---|
| A 来源 | `source-strip.tsx`、`source-detail.tsx`、`playbook-reader.tsx`、`i18n/sources.ts` | 来源卡(自动换行、带 `data-tour="trade-runs"`)、`⋯` 菜单(暂停/继续、判断方式,访客不能暂停 AI Scan)、来源详情(漏斗、按层分组的被挡原因带原文和怎么改、不算被挡的折叠、本来源线程、Jev 记录、链接)、playbook 阅读器(英文/中文原文、分块、数字高亮) |
| B 下单 | `order-ticket.tsx`、`i18n/ticket.ts` | 从 `trade.tsx` 的 OrderPanel / MarketToggle / BasisStrip 搬出来(复制,不改 trade.tsx),加止损旁一行「Stop x% · ≈y× 1h ATR · loses ≈ z USDT」、仓位换算行、两组检查、「Move stop to …」、提交按钮「Long SOL」 |
| C 规则 | `rules-drawer.tsx`、`i18n/rules.ts` | 三组规则、止损底线「% of price / ATR」切换、ATR 模式实时换算表(读 `stop_conversions`,编辑中的未保存值也实时算)、打到止损亏多少、用量条、Save(实盘带 confirm)、agent 提议卡、访客只读 |
| D 线程 | `threads-table.tsx`、改 `thread-detail.tsx`、`i18n/threads.ts` | 原线程栏 + 底部持仓/挂单合成一张表:Open / Orders / Closed today、来源过滤、行内平仓确认、外部持仓写 External;线程详情抽屉(止损几倍 ATR 按规则周期) |

### 第 2 块:页面外壳和收尾(我,串行)
- 重写 `pages/trade.tsx`:状态行(改 `context-bar.tsx`,保留 `data-testid="trade-context-bar"`)、一行静态说明、来源卡、图表 + 下单面板、线程表、右侧抽屉(用现有 `ui/sheet`),把 mutation 和查询接到各块。
- 删掉不再用的:`sources-column.tsx`、`source-card.tsx`、`risk-panel.tsx`、`thread-row.tsx`(确认没有别处引用再删)。
- 更新 `test/trade-page.test.tsx`、`test/trade-sources.test.tsx`。

### 验收
1. `tsc --noEmit`、交易页 vitest(含新单测)、`vite build` 全过。
2. 在 5191 接一个跑 c5e5077 之后后端的预览网关,用 headless Chrome 脚本走三条路径(看懂谁在交易 / 自己下一单 / 查 AI Scan 为什么只下一单),1440 和 500 宽各截图,控制台零报错。
3. `VITE_EDITION=judge` 构建看访客视角:规则只读、AI Scan 暂停置灰、Paper · Judge demo、Tour 目标在。
4. 交给 jacky-31 审 + jacky-3f 评审;评审版部署 jacky-31 做。

提交:每块一个提交,按路径 add,不 push。
