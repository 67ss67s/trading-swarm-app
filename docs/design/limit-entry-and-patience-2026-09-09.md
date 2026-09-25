# 限价入场与挂单耐心(2026-09-09)

Jacky:「目前很多入场都是市价直接进,其实应该有限价进的,然后 agent 还能灵活判断订单要不要接着放着」。

代码:`packages/gateway/src/demo/entry-policy.ts`;接线 `context.ts`(两条证据 + 规则 10 / 10b)、`runtime.ts`(闸、tick 对齐、唤醒、复查节奏)、`holding-policy.ts`(挂单的 INVALIDATE 放行)、`graph.ts`(守卫 `entry_style`)、`workflow.ts`(两个开关)。测试 `test/demo/entry-policy.test.ts`(10 例)。

## 1. 为什么一直是市价

`breakout_retest` 的规则里本来就写着「回踩确认(收在突破位外侧、量比 ≥ retest_vol_min)→ 市价;刚突破未回踩 → 限价挂突破位与 EMA20 之间」。这条规则**只存在于 prompt 的策略文本里**,没有任何代码算过它,也没有任何闸看过它。模型于是一路 `entry: "market"`:市价永远能成交,限价要等,而 prompt 里没有任何东西告诉它等是划算的。

执行层其实四个后端都支持限价(paper 本地撮合、Rust demo、`binance-cli`、agent_mcp 与直连 MCP 都发 `LIMIT + price + timeInForce=GTC`),所以这不是能力问题,是决策证据缺失。

顺带查出一个真钱缺陷:`limit_price` 从模型原样透传到交易所,**全链路没有 tick_size 对齐** —— 真账户会直接吃 `PRICE_FILTER` 拒单。

## 2. 改法一:把「市价还是限价」变成代码算的证据

`entryStyleAdvice()`(纯函数)在每次扫描时算出:

- `recommended`:回踩已确认且距突破位 ≤ 1 ATR → `market`,否则 `limit`;
- `zone`:参考挂单区。锚点 = **现价不利侧最近的那个结构位**(做多取现价下方的突破位与 EMA20 中较高者),宽度 = 该 horizon 的 `entry_zone_atr × ATR`,整段落在现价的不利侧 —— 挂在有利侧的限价单等于市价单,没有意义;
- `market_blocked`:这次市价单会不会被闸拒。

进证据 `入场方式(代码计算)`,进系统规则 10。

### 闸只挡「真追单」,不挡「没回踩」

`entryStyleGate` 是只拒不改的代码闸(`workflow.entry_style = 'prefer_limit'` 时生效),判据只有一条**客观距离**:距突破位 > `MARKET_CHASE_ATR`(1 ATR)的市价开仓拒掉。

距离由 `distToBreakAtr()` **自己算**,量到「这根之前」的 20 根极值。第一版直接用了 `scanChecklist.dist_to_break_atr`,而那个字段用的是**含当根**的 `swing_high_20` —— 刚突破的那根自己就是最高点,距离恒等于 0,闸几乎永远不会触发(09-09 复审 B3 指出,已修)。

为什么不是「回踩没确认就拒市价」:价格就贴在突破位上时市价没有错,拒掉只会让系统整体不交易。策略自己的「不追」上限是 1.5 ATR,市价拿的是最坏那一档成交,给它三分之二。距离算不出来时**不拦** —— 证据缺失不是拒单的理由。

推动限价的主力是证据与规则 10,不是闸。闸只兜住最糟的那一类。

### tick 对齐

`alignLimitPrice(price, tick_size, side)`:做多向下取、做空向上取(取对自己有利的那一格)。对齐在 `openThreadFromProposal` 最前面做,**数量计算、组合闸、持仓计划、审批、发送用的都是对齐后的价**(第一版漏了 `computeSizing` 仍读模型原价,导致最小名义/名义上限按未对齐价算,09-09 复审 B1 指出,已修)。唯一例外是 `executeEpisode` 里那次 `evaluateGates` —— 它在建线程之前跑,用的仍是模型原价,偏差 < 1 tick。

**没做到的**:对齐用的是浮点数除法加 `1e-9` 兜底,不是仓库规矩要求的十进制定点。极大价格或极小 tick 上会退错一格;对齐到 0 时原样返回(仍然不合法)。要按十进制整数缩放重写。

## 3. 改法二:挂单要不要继续放着

### 先解锁,否则证据是死的

原来 `evaluateHoldingReview` 对 `pending_entry` 只在三条路径上给出 `['HOLD','INVALIDATE']`(已核实的重大事件 / 失效确认 / 双周期反转),其余全是 `['HOLD']`。也就是说「价格已经跑掉、突破结构没了」这类理由**根本选不出撤单** —— 补再多证据模型也撤不了。

现在挂单的 `INVALIDATE` 是常开的边:撤一张没成交的入场单不改任何已批准的经济字段,过撤的代价是错过一笔而不是亏一笔。

**两个例外**都只给 `HOLD`:`market_stale_keep_protection`(行情快照过期,与「`scan:stale` 不许 PROPOSE」同一套 fail-closed 姿态)、`legacy_plan_unavailable`(根本没有持仓计划的旧线程 —— 判据都来自计划,没有计划就没有依据)。后者的分支在 stale 检查**之前**返回,所以必须单独列(09-09 复审 B2 指出,已修)。

**「撤单不动钱」这句要限定**:撤单本身不动钱,但「撤单请求成功」不等于「这单从没成交过」。交易所在最后一次读取之后成交、或撤的是余量时,把线程直接标成 canceled 会留下一张没人管的仓。现在 `cancelEntry` 在入场调用还在飞(`entry_submitting_since`)时一律不撤、保持 pending 等回执(界面入口早有这道闸,模型的 INVALIDATE 走的是另一条路,以前没有,09-09 复审 B2 的 P0,已修)。**仍然没做**:撤单成功后没有回查成交量就判 canceled —— 这条竞态还在,见「已知代价」。

### 再给证据

`pendingEntryMetrics()` 在每次挂单复查时算:等了几根(按复查周期)、现价在不在入场区、距入场区几个 ATR、**是否已经越过入场区并离开 ≥ 1 ATR**(单子等不到了)、最近收盘是否已回到突破位另一侧(结构没了)、最近 3 根量能中位数是否跌到前 20 根的 60% 以下(量枯)。

`cancel_warranted` 是代码意见,由三条**结构性**理由构成:等待超上限、价格跑掉、结构没了。量枯只报不判 —— 它是提示,不是撤单理由。进证据 `挂单耐心(代码计算)`,进规则 10b。

它**只管已经挂在交易所的限价单**:

- 市价单停在 `pending_entry` 说明只拿到 ACK 还没查到成交,那是**查单**的问题,撤单只会把仓位状态弄得更不清楚;
- `entry_submitting_since` 非空(调用还在飞)时不出度量 —— runtime 本来就拒绝撤在途单,给模型看「该撤了」等于制造一次必然失败的动作。

### 还要能醒过来

两处唤醒缺口一起补:

- `nearEntryZone()`:价格进入入场区附近(0.3 ATR)或已越过 1 ATR 时立刻叫醒一次。原来 `nearProtection` 只对持仓生效,挂单没有任何价格触发的唤醒。
- `pendingReviewDue()`:挂单的入场窗口寿命与持有周期无关(swing 策略的回踩也就那几根),所以挂单**最早一小时**就可以复查一次,不跟着 horizon 被拖到 4h / 24h。scalp 仍是每次都过。**注意这是「资格」不是「保障」**:复查只在 K 线收盘或事件到来时才被调用,4h 周期的币自然唤醒仍要等到 4h,再叠加队列与判断上限。要真做到定时复查得有独立 deadline(未做)。

## 4. 两个开关(只有人能改)

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `entry_style` | `prefer_limit` | `free` = 模型自己选;`prefer_limit` = 距突破位 > 1 ATR 的市价开仓被闸拒 |
| `entry_max_wait_bars` | `8` | 挂单等这么多根(复查周期)还没成交,代码就认为入场窗口过去了 |

## 5. 已知代价与没做的事

- **撤单不退当日开仓计数**:`max_opens_per_day` 数的是开过的线程。震荡市里「挂了撤、撤了挂」会烧掉当天名额,让真正的机会开不进去。这也是 `cancel_warranted` 只认三条结构性理由、不认「等烦了」的原因。要真正解决得改计数口径,本次没动。
- **撤单后没有回查成交**:`cancelEntry` 收到 `{ok:true}` 就把线程标 canceled,不查 `executed_qty`、不重读线程做版本比较;而 agent_mcp 后端把「订单不存在」也算成功。交易所在最后一次读取之后成交时会留下孤儿仓,`resolveOpenIntents` 还会顺手把 unknown 意图收敛成 failed。这是既存设计缺陷,被「挂单 INVALIDATE 常开」放大了可达性。**上真钱之前必须先修这条链**。
- **没有「改价续挂」这条边**。判断图上挂单只有 HOLD / INVALIDATE。想换价格 = 撤掉 + 下一次判断重新提议,会多烧一个开仓名额。
- **`ran_away` / `structure_gone` 的名字比事实强**:前者只知道此刻价格在入场区的有利侧一个 ATR 之外,不知道价格曾经穿过区间;后者用的是滚动的突破位与 EMA20,不是开仓时冻结的失效线。当成「当前远离」「当前结构不利」读,别当成已经证实的事实。
- **没有 postOnly / GTX**:四个后端都写死 GTC,`EntryRequest` 里没有这个字段。限价单有可能吃成 taker。
- **paper 后端两处成交价口径不一致**:立即可成交时按 mark 成交,挂单后在 tick 里按 limit 价成交。用纸面数据评估限价入场的滑点会偏乐观。
- **agent_mcp 通道的限价参数是模型拼的**:`price` / `timeInForce` 只有 prompt 约束,发出去之后没有回读对拍。真钱走限价前应当补一次「按 CID 回查订单,比对 price 与 `thread.entry.price`,不一致就 attention」。这不是本次引入的,但限价用得越多它越要紧。
- 入场区宽度(`entry_zone_atr`)仍然只进 prompt,**代码没有校验**模型给的 `entry_zone` 宽窄。
