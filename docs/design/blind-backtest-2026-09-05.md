# 盲测回放:什么是盲的,什么不是(2026-09-05)

实现:`packages/gateway/src/demo/backtest.ts`(引擎)、`outcome.ts`(成交语义,与 eval 共用)、迁移 `0007_demo_backtest.sql`、路由见 `docs/demo/v3-ui-contract.md` §9.8、前端 `#/replay`。

## 0. 为什么

Jacky 的原话是「看看它的入场靠不靠谱」。线上循环只能一天天等结果,而 eval-a 量的是**判断质量的分项指标**(契约、证据、越权边),不是**一段行情走完之后这套判断赚不赚钱**。中间缺的就是这个:把 agent 放回历史里,一根一根重新判断,只让它看见当时看得见的东西,然后按 R 记账。

只要有一处泄漏未来,结论就全是假的 —— 所以这份文档的重点不是功能表,而是**边界在哪里、哪里还漏风**。

## 1. 盲测不变式

> 在收盘时刻 T 的那次判断里,喂进 `buildContext()` 的每一根 K 线都满足 `close_time ≤ T`,并且所有派生数字都只由这些 K 线算出。

怎么保证的:

1. **切窗口的地方只有一个**。`visibleWindow(bars, T, count)` = 二分找到最后一根 `close_time ≤ T` 的 K 线,再往回取 `count` 根。运行周期取 60 根、1h 取 120 根、4h 取 80 根、1d 取 260 根 —— 与线上 `executeEpisode` 的 `fetchKlines(symbol, tf, 60/120/80)` 逐一对齐。
2. **指标不是另算的**。特征走线上同一个 `tfFeatures()`,日线状态走同一个 `dailyRegime()`,触发器走同一个 `detectTriggers()`,24h 涨跌用 `ticker24hFromBars()` 从可见 K 线重建(币安的 `/ticker/24hr` 是「此刻」的端点,历史上不存在)。
3. **每一步都断言**。`assertBlind(inputs, T)` 检查 `now`、`market.as_of`、每个周期特征的最后一根 open_time、日线状态的 `as_of` 都不越过 T,越界直接让这次回测 failed 而不是悄悄产出好看的数字。
4. **测试从模型那一侧复核**。`test/demo/backtest.test.ts` 里的 “NO FUTURE DATA” 用例把 brain 实际收到的 user prompt 抓下来,把「最近 4 根」证据里的 K 线时间解析回时间戳,断言没有一根的收盘晚于该次判断的边界,并断言上下文里的 `mark` 恰好是边界那根的收盘价、不含后一根的 OHLC。
5. **成交也不许偷看**。市价单在**下一根的开盘**成交(不是判断那根的收盘),复查发生在**该根收盘之后**,所以这一根的止损/止盈先结算、模型后说话。

## 2. 判断链路是复用的,不是复制的

| 环节 | 盲测用的东西 |
|---|---|
| prompt / 证据登记 | `context.ts` `buildContext()`,同一个 `PROMPT_VERSION` |
| 输出契约 | `schema.ts` `validateJudgment` + `extractJson` + `findMemoryNumberLeaks`,同样**只修一次**,两次都不合契约 fail-closed(扫描 → NO_TRADE,复查 → HOLD) |
| 允许的动作 | 判断图 `graph.ts`(经 `buildContext` 的 `allowed_actions`) |
| 开仓闸 | `gates.ts` `evaluateGates`(止损方向/距离、止盈方向、信心下限、每日开仓上限、无持仓才开仓、证据新鲜度) |
| 复查语义 | `threads.ts` `reduceReview`(HOLD / REDUCE / EXIT / INVALIDATE 的效果从图上读) |
| 成交/止损/止盈/R | `outcome.ts`,与 eval-a 同一份实现(eval-a 的 `outcome.ts` 现在只是别名) |

唯一在两处存在的逻辑是**解析+修复轮的编排**(`backtest.ts` 的 `judgeOnce` 对着 `runtime.executeEpisode` 的中段)。prompt 本身没有分叉。改契约策略时两处要一起改 —— 这是已知的债。

## 3. 哪些不是盲的 / 拿不到

| 线上有 | 回测里 | 处理 |
|---|---|---|
| 资金费率(`premiumIndex`) | **有历史值** | 走 `/fapi/v1/fundingRate` 按时间取 ≤ T 的最后一条;取不到时留空 |
| 持仓量 OI 与 1h 变化 | **没有** | 币安 `openInterestHist` 只留 30 天,更早无解。`market.open_interest = ''`,`oi_change_1h_pct = null` |
| 24h 涨跌/高低/成交额 | 有(重建) | 从可见 K 线算,与 `/ticker/24hr` 会有小数级差异(它是滚动 24h,我们是 96 根 15m) |
| 信息员 / 新闻 / 恐惧贪婪 | **没有** | `market_state = null`。历史新闻拿不到,拿得到也没法保证「当时就知道」。**这是最大的口径差**:线上判断里有新闻证据,回测里没有 |
| 长期记忆 | **故意不给** | 记忆是事后写的,注入等于泄漏未来。`memories: []` |
| 5 分钟急拉急跌(fast_move) | **不会触发** | 回测没有 tick,只有 K 线。`fast_move_pct = null`,触发器 1 号规则在回测里永远不响 |
| 盘口/滑点/手续费/资金费结算 | **不计** | 成交按 K 线价,R 是毛的 |
| 数量、名义、最小下单量 | **不算** | 回测按 R 记账,与仓位大小无关,所以不跑 `computeSizing`;交易所最小名义之类的约束不在盲测范围 |

**证据条目会因此少两条**(资金费率、持仓量)。`context.ts` 对空字符串的处理是**不登记这条证据**,而不是登记一个编造的 0 —— 宁可让模型少看见一条,也不能让它引用一个假数字(系统规则 2b 允许它引用证据里的原数)。副作用:回测里的 `E` 编号与线上同一时刻的编号不一定一一对应;编号在每次判断内部自洽,不影响契约校验。

## 4. 记账口径

- **R** = 有符号盈亏 ÷ 入场时的止损距离,分母**永不重算**。
- 一根 K 线上同时触及止损与止盈 → **按止损**(fail-pessimistic)。跳空穿越 → 按开盘价出。
- `horizon_bars`(默认 48):挂单等这么多根还没成交 → 撤单(`unfilled`,不计 R);持仓拿这么多根 → 按收盘价出(`expired`,计 R)。
- `REDUCE` 按「减半」处理:在该根收盘价结掉一半,剩下的继续走;成交后的 R = 剩余腿 R × (1−已减比例) + 已减腿 R × 已减比例。
- 区间 `to` 之后**不再判断**,但仍会用后面的 K 线把未了结的仓位走完(止损/止盈/到期);数据用尽仍未平的记 `open`,**不计入胜率**。
- `max_drawdown_r` = 按成交顺序累计 R 曲线的最大峰谷差。
- `missed_move`:每次 NO_TRADE / WATCH 之后 `horizon_bars` 根内的最大绝对偏离,单位是当根的 ATR —— 「站在场外错过了多大行情」。

## 5. 成本与闸

- 估算:`候选根数 × 单次判断价`,单次判断按 1600 输入 / 400 输出 token 走 `brain.ts` 的价目表(GLM-5.3 ≈ ¥0.0064,与工作流面板上写的 ¥0.006 同源)。订阅制大脑(claude/codex)没有单价 → 三个 ¥ 字段都是 `null`,前端显示「订阅额度,不计费」,不要显示 ¥0。
- 估算**不含复查**:持仓期间的复查次数事前不可知,所以 `est_cny` 是下界,`max_cny = max_judgments × 单价` 是硬上界。
- `mode` 默认 `triggers`(与线上 `scan_mode = 'triggered'` 同一套规则),`every_close` 只在短区间演示用。
- 回测**不受 `daily_judgment_cap`**(用户主动发起的动作不该被自动循环的预算挡住),花费也**不计入 `usage_today`**,只在 run 的 `summary.cost` 里单独算;回测判断不写 `demo_episodes`,所以不会污染判断记录页与今日用量。
- 同一进程同时只跑一个回测,顺序执行;取消在两步之间生效。

## 6. 已知缺口(下一轮要动的)

1. **没有新闻/信息员**,而线上判断里有。所以盲测衡量的是「只看结构的这套 playbook」,不是线上那套的完整复现。想补:把 `demo_info_events` 里已经落库的历史新闻按 `occurred_at ≤ T` 回放,只对**网关运行过的那段历史**成立。
2. **没有 fast_move**,触发器少一条;`triggers` 模式的候选数比线上偏少。
3. **修复轮的编排在两处**(`runtime.executeEpisode` 与 `backtest.judgeOnce`),会漂。
4. **REDUCE 的建模粗糙**(固定减半、按收盘价),线上是真下单。
5. **单币**:一次回测只走一个 symbol,组合层面的 `max_open_threads` / 日亏停没有被检验。
6. **样本噪声**:模型自身的采样噪声在 eval 里量到过 ~30%(`docs/eval/results-2026-09-04.md`),回测只跑一遍,少量交易的胜率**不可当作统计结论**;要下结论得像 eval 那样多采样取众数,或者把区间拉长到几十笔交易。
7. **K 线缓存不校验完整性**:`~/.trading-swarm/demo/klines/<symbol>-<tf>.json` 只按「首尾覆盖 + 步长连续」判定命中,币安补发/修正历史 K 线不会被发现,删文件即可重取。
