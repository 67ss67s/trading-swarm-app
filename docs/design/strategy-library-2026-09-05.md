# 策略库:不可变版本 + 归因闭环(v3.5,2026-09-05)

> 落地 `docs/research/scan-and-strategy-decision-2026-09-05.md` §2 的 **E**(先加多周期对齐与波动压缩→扩张)和 **F**(不可变版本对象 + 晋升门),数据模型沿用 外部评审`docs/research/strategy-construction-2026-09-05.md` Part 2。接口契约见 `docs/demo/v3-ui-contract.md` §9.11。

## 1. 为什么

Jacky 描述的那套美股 agent 流程有六步:①按规则扫出错价 → ②从均值回归历史算出回归概率与期望时间 → ③据此定仓位/对冲 → ④执行、记录、归属 → ⑤复盘结果、追问题点位、改机制 → ⑥用回测+回放验证改动。

到 v3.4 为止我们有 ①(触发器 + 扫描清单)和 ③(`gates.ts` 的风险预算),**②④⑤⑥ 全缺**。缺的根因是同一件事:agent 只有一条策略,而且它是 `workflow.playbook_text` 里的一段自由文本。一段文本没有身份,所以:

- 没法回答「这次是哪条策略赚的钱」(④ 归属);
- 改一个阈值没有版本、没有 hash,改完之前的成绩就作废了,也回不去(⑤ 改机制);
- 「验证改动」只能整体重跑,没法说「v2 比 v1 好在哪」(⑥)。

所以 v3.5 做的第一件事不是加策略,是给策略一个**身份**。

## 2. 数据模型:不可变的版本化对象

`packages/gateway/src/demo/strategies.ts`,落在 `demo_strategy_version`(`migrations/0008_demo_strategy.sql`),主键 `(id, version)`。

```ts
{ id, version, content_hash, name, family, status,
  trigger:   { kinds: TriggerKind[], min_timeframe, cooldown_bars },
  checklist: { required: string[], timeframes: string[] },
  rules:     { entry: string[], invalidation: string[], exit: string[], sizing_note? },
  params:    Record<string, { value, min, max, unit?, note? }>,
  eval_stats:{ backtests, trades, win_rate, expectancy_r, mae_r_p50, last_run_id, noise_note },
  created_at, parent_version }
```

三条纪律:

1. **`content_hash` = sha256(name | family | trigger | checklist | rules | params)。** `status` 与 `eval_stats` 刻意**不进** hash —— 它们是版本行上的可变元数据(晋升、回测成绩会改它们),改不了这个版本被判断时用的那份内容。任何参数值、范围、单位、规则措辞的变化都换 hash,也就是换版本号。
2. **新版本一律从 `draft` 起步**,不继承父版本的状态。`breakout_retest` 的 v1 是 `paper`,给它改一个参数得到的 v2 是 `draft`,要重新走完晋升阶梯。
3. **落库的只有数据。** 触发判定(`strategyWakes`)和「清单证据怎么算」(`STRATEGY_EVIDENCE`,按 strategy id 注册)是代码。一个策略的新版本换的是数字和措辞,不是行为的实现 —— 这样版本才可回放,也不用把可执行代码塞进 sqlite。

## 3. 五条内置策略(种子,`seed()` 幂等)

`breakout_retest` 初始状态是 `paper`(它就是今天在跑的 playbook),其余四条是 `backtest`。规则一字不改地抄在下面,因为它们就是模型看到的原文。

### 3.1 `breakout_retest` — 突破-回踩(trend_continuation,paper)

- 触发 `breakout / retest / ema_cross`,`min_timeframe` 15m,冷却 4 根。清单需要 `scan_checklist`、`daily_regime`,周期 15m/1h/4h。
- 入场:
  - 方向随 1h EMA20/EMA50;4h 反向只许限价回踩、信心 ≤ 0.5。
  - 回踩确认(收在突破位外侧、量比 ≥ `retest_vol_min`)→ 市价;刚突破未回踩 → 限价挂突破位与 EMA20 之间。
  - 距突破位 > `chase_atr_max` ATR 或 ATR% < `atr_pct_floor` 不做;日线 bear 不做多、bull 不做空,range 要量比 ≥ `range_vol_min`。
- 失效:收盘回到突破位另一侧,或 1h 与 4h 双双转反向。
- 离场:论点未变 HOLD;失效 EXIT;浮盈 ≥ 1R 且结构转弱 REDUCE;挂单远离入场区 INVALIDATE。
- 仓位:止损在最近 swing 外 ≥ 0.8 ATR,第一止盈 ≥ 1.5 倍止损。
- 参数:`atr_pct_floor`=0.4% [0.05,2] · `chase_atr_max`=1.5 ATR [0.5,3] · `retest_vol_min`=1 倍 [0.5,3] · `range_vol_min`=1.5 倍 [1,3]
- 额外清单证据:**没有**。它完全复用 `scanChecklist()` 已经在算的字段(决定稿 §2 E:零新字段)。

### 3.2 `mtf_alignment` — 多周期对齐(mtf,backtest)

- 触发 `breakout / retest / ema_cross`,`min_timeframe` **5m**,冷却 4 根。清单需要 `scan_checklist`。
- 入场:
  - 5m/15m 出现突破/回踩/EMA 交叉,且 15m 与 1h EMA20/50 同向,方向随之。
  - 4h 只作否决:4h 反向且距 EMA 超 `veto_atr` ATR 一律不开;4h 同向不算入场理由。
  - 距突破位 ≤ `chase_atr_max` ATR 才入场,超出只 WATCH。
- 失效:确认周期(15m 或 1h)收盘转反向,或价回到触发位另一侧。
- 离场:确认周期仍同向 HOLD;转向 EXIT;浮盈 ≥ 1R 且 15m 收在 EMA20 另一侧 REDUCE。
- 仓位:止损在触发周期 swing 之外(≥ 0.8 ATR),第一止盈 ≥ 1.5R。
- 参数:`confirm_tf_count`=2 [1,3] · `veto_atr`=1 ATR [0.3,3] · `chase_atr_max`=1.5 ATR [0.5,3]
- 额外清单证据:**没有**(同上,复用扫描清单的 `trend_agree` / `dist_to_break_atr`)。它是 meta-strategy,不是独立 alpha —— 4h 只当否决项,正是 调研里那条「不要让 `confidence_floor` 代替趋势规则」。

### 3.3 `vol_compression_expansion` — 波动压缩→扩张(volatility,backtest)

- 触发 `vol_spike / breakout`,`min_timeframe` 15m,冷却 6 根。清单需要 `indicator_snapshot`、`scan_checklist`。
- 入场:
  - 先压缩:带宽 90 根分位 ≤ `bb_width_rank_max`,或 squeeze 连续 ≥ `squeeze_bars_min` 根。
  - 再扩张:同一根同时突破 + 量比 ≥ `vol_spike_min`,方向由突破决定。
  - 只做压缩后第一次扩张;已走出 `chase_atr_max` ATR 不追。
- 失效:`revert_bars` 根内收回压缩区间且量比 < 1,或收盘回到布林中轨另一侧。
- 离场:量比不衰减且价在带外 HOLD;回中轨 EXIT;浮盈 ≥ 1.5R 且量比 < 1 REDUCE。
- 仓位:止损在压缩区间另一端外(≥ 1 ATR);第一止盈 ≥ 2R,靠少数大赢家。
- 参数:`bb_width_rank_max`=20% [5,40] · `squeeze_bars_min`=6 根 [3,20] · `vol_spike_min`=1.8 倍 [1.2,4] · `revert_bars`=2 根 [1,5] · `chase_atr_max`=1.5 ATR [0.5,3]
- 额外清单证据「压缩→扩张清单(代码计算)」:带宽 90 根分位、ATR% 90 根分位、squeeze 开关与连续根数、当根量比,以及**代码判定**的 `压缩成立=是/否`、`扩张成立=是/否`。数据来自 `indicators.ts` 的 `indicatorSnapshot()` / `squeeze()`。可见 K 线 < 30 根时这条证据直接写「不可得 —— 本次不得按本策略 PROPOSE」,而不是填 0。

### 3.4 `funding_oi_extreme` — 资金费率/OI 极值(derivatives,backtest)

- 触发 `funding / fast_move`,`min_timeframe` 15m,冷却 8 根。清单需要 `funding_stats`、`scan_checklist`。
- 入场:
  - |费率| ≥ `funding_abs_min` 且 30 天 z ≥ `funding_z_min` 才算极值,只看绝对值不算。
  - fade:正极值 + OI 降 ≥ `oi_change_min` 做空;负极值 + OI 降做多。
  - follow:极值但 OI 仍升且 1h/4h 同向 → 只许顺势限价挂回踩。
  - 距结算 `minutes_before_funding` 分钟内不新开。
- 失效:费率回到 ±0.02% 内而价未跟随,或 OI 回升且价反向走出 1 ATR。
- 离场:费率仍极端且论点未破 HOLD;归一且浮盈 > 0 REDUCE;归一且论点已破 EXIT。
- 仓位:条件性策略:止损 ≥ 1.2 ATR,仓位不超常规,第一止盈 1.5R。
- 参数:`funding_abs_min`=0.05% [0.01,0.5] · `funding_z_min`=2σ [1,4] · `oi_change_min`=1% [0.2,10] · `minutes_before_funding`=30 分钟 [0,240]
- 额外清单证据「资金费率极值(代码计算)」:当前费率、30 天样本量/均值/标准差/z、`极值成立=是/否`、OI 1h 变化、距结算分钟数。费率历史走 `fapi/v1/fundingRate`(`market.ts` 新增的 `fetchFundingRateHistory`,runtime 里按币缓存 1 小时;回测直接用引擎已经加载的 `series.funding`),OI 走已有的 `fetchOpenInterestHist`。**拿不到费率就写「不可得」并禁止 PROPOSE**,不编 0。

### 3.5 `range_mean_reversion` — 区间均值回归(mean_reversion,backtest)

- 触发 `fast_move / vol_spike / kline_close`,`min_timeframe` 15m,冷却 6 根。清单需要 `reversion_stats`、`indicator_snapshot`、`daily_regime`。
- 入场:
  - 只在震荡:日线 range 或 ADX14 < `adx_max`。
  - 价距 EMA20 ≥ `dev_atr_min` ATR,反着偏离方向做。
  - 「回归统计」里 `horizon_bars` 根内回归比例 < `min_reversion_prob` 不做。
  - 目标 EMA20/VWAP,不加仓摊平。
- 失效:收盘再偏离 0.5 ATR,或 ADX14 升破 25 / 日线转 trend。
- 离场:触及 EMA20 EXIT;超回归中位根数 2 倍未回归 EXIT;浮盈 ≥ 1R 且走完一半 REDUCE。
- 仓位:止损在偏离方向再 `stop_atr` ATR;高胜率低盈亏比,止盈即 EMA20。
- 参数:`dev_atr_min`=2 ATR [1,4] · `adx_max`=20 [10,30] · `horizon_bars`=12 根 [4,48] · `min_reversion_prob`=55% [30,90] · `stop_atr`=1 ATR [0.5,2]
- 额外清单证据两条:「回归统计(代码计算)」和「偏离/震荡清单(代码计算)」。前者就是下一节。

## 4. 步骤 ②:回归概率与期望时间(`reversion-stats.ts`)

`reversionStats(klines, opts)` 是纯函数。取最近 N 根(**至少 400,不够就返回 `null`**),对 k ∈ {1.5, 2, 2.5} 与 H ∈ {6, 12, 24}:

- 一个**样本** = 第 i 根收盘时 `|close − EMA20| ≥ k · ATR14`;
- 一次**回归** = 之后第 j 根(i < j ≤ i+H)的高低区间夹住了那根自己的 EMA20;
- 输出每个 (k, H) 格子的 `samples` / `prob` / `median_bars`。

它渲染成一条「回归统计(代码计算)」证据,所以数字是**代码算的**,eval 的 hallucinated_numbers 把它当作有来源的数,模型可以直接引用。证据文本自带两句诚实边界:样本高度重叠(同一段偏离会被连续多根重复计数,概率是先验不是独立试验频率),以及没有盘中 tick、只用高低区间判断触及。

测试用两条合成序列钉住方向:围绕 1000 的正弦(周期 20 根)在 k=2/H=12 上回归率 > 80%,单边爬升的趋势序列要么根本达不到 2 ATR 偏离(样本 0)要么 < 30%。

## 5. 接进判断:`demo-playbook-v5`

`workflow.active_strategies: string[]`(默认 `['breakout_retest']`)。`buildContext` 的变化只有两处:

1. 原来的 `playbook_text` 段落被换成「可用策略:」+ 本次被唤醒的策略的规则块;`playbook_text` 降级成后面的「补充说明(用户写的,不覆盖策略)」。每条策略的 `evidence()` 钩子再往证据登记表里加它自己的清单行(复用扫描清单的两条不加)。
2. 多一条硬红线 9:PROPOSE 必须给 `strategy_id`,且必须是本次列出的之一。

**没有启用任何策略时,渲染与 v4 逐字相同**(还是 `Playbook(…)` + 全文),录好的 eval case 照样跑 —— 这是刻意留的向后门。

谁被「唤醒」:实盘只认 status ≥ `paper` 的(`StrategyLibrary.resolve({ allow_below_paper: false })`),再按 `strategyWakes(spec, tf, hits)` 过一遍本次触发;回测允许点名 `backtest` / `shadow`(那正是它们存在的意义)。这层过滤同时也是省 token 的手段:启用三条不等于每次都渲染三条。

契约侧:`validateJudgment(raw, refs, { strategies })` 在 `strategies` 非空时,把「PROPOSE 没给 strategy_id」和「给了不认识的 id」都当契约错误 → 走**同一轮**修复 → 再不行 fail-closed(scan `NO_TRADE` / review `HOLD`)。`Judgment.strategy_id` 与 `StrategyThread.strategy_id` 都是可选字段,老数据读得回来。

提示词膨胀:两条策略同时启用约 +900 字,其中约 60 字(规则 9 + 表头)与条数无关。

## 6. 步骤 ④:按策略归属

- `BacktestParams.strategy_ids`(默认 = `workflow.active_strategies`)+ `attribute: boolean`。
- 每个 `BacktestStep` 与 `BacktestTrade` 记 `strategy_id`;`demo_backtest_step` 与 `demo_threads` 各加一列,方便直接 GROUP BY。
- `BacktestSummary.by_strategy` 按策略拆成交(`trades / wins / losses / win_rate / expectancy_r / sum_r / mae_r_p50 / proposals`),模型没标注的进 `unattributed` 桶 —— **不硬塞给某条策略**。
- `BacktestSummary.strategies` 记 `id@version@content_hash@status`:一份成绩永远说得清它测的是哪份内容。
- `BacktestEstimate.candidates_by_strategy`:每条策略自己的触发集合会唤醒多少根,不调模型就能算 —— 这是「哪个触发值得付费」这个问题最便宜的证据来源。
- 跑完把 `by_strategy` 写回各策略 head 的 `eval_stats`(`backtests` 累加,其余覆盖成最近一次,`noise_note` 恒为「单次采样,噪声底 ~30%」)。**写的是统计不是内容**:版本号与 `content_hash` 不动。

## 7. 步骤 ⑤⑥:归因闭环(`attribution.ts`)

`POST /api/backtest/:id/attribute`(或 `attribute: true` 跑完自动执行)让**便宜大脑**读这次回测的成交(入场/出场/R/MAE/MFE)、导致它们的判断、亏损单当时的理由,以及被闸拦下的提议,吐 ≤ 3 个「问题点位」。每个点位必须同时说清四件事:

| 字段 | 意思 |
|---|---|
| `evidence_said` | 证据当时显示了什么 |
| `rule_said` | 规则当时说了什么 |
| `actual` | 实际发生了什么 |
| `proposal` | 提议怎么改,**带类型** |

提议只有三种类型:`rule_wording`(新措辞)、`param`(`strategy_id` + 参数名 + 落在 `[min,max]` 内的新值)、`checklist_item`(代码清单缺的一项)。**越界的参数提议整条丢掉**,不留一个「大概想改点什么」的记录。

每个点位落两处:一行 `demo_backtest_attribution`,和一条长期记忆提案(`param` → `calibration`,其余 → `lesson`;`status=proposed`,`source_refs=[run_id]`,`tags=[strategy_id, symbol, 'backtest_attribution', kind]`,`confidence` 0.4)。**永远不 apply**:记忆等人批准,参数等人在界面上点「生成新版本」。归因 prompt 自己也带着这句约束 —— 一次回测是单次采样,噪声底约 30%,不要因为一两笔亏损就提议大改。

## 8. 晋升门

```
draft → backtest → shadow → paper → live_capped        (retire 随时,不可回)
```

| 边 | 门 |
|---|---|
| `draft → backtest` | 对象合法(schema/范围)即可 |
| `backtest → shadow` | `eval_stats.backtests ≥ 1` 且 `trades ≥ 20` |
| `shadow → paper` | `expectancy_r > 0` |
| `paper → live_capped` | 人工确认 `confirm: true` |

只准往前**一格**。这是 外部评审提案的简化版:它要求 shadow 门用「≥ 200 次独立触发 + 样本外 + Deflated Sharpe + 费用/滑点」,我们现在的回测量级还够不着那个门槛,所以先立一个**能被现有数据判定**的门,并把差距写进下面的「还没做」。`retire` 之后想复活,只能生成新版本 —— 退役是终态。

## 9. 文件

| 文件 | 干什么 |
|---|---|
| `packages/gateway/src/migrations/0008_demo_strategy.sql` | `demo_strategy_version`、`demo_backtest_attribution`,给 `demo_threads` / `demo_backtest_step` 各加一列 `strategy_id` |
| `packages/gateway/src/demo/strategies.ts` | 数据模型、五条内置、清单证据 registry、渲染、`StrategyLibrary` |
| `packages/gateway/src/demo/reversion-stats.ts` | 步骤 ② 的纯函数 |
| `packages/gateway/src/demo/attribution.ts` | 归因 prompt / 解析 / 落库 + 记忆提案 |
| `packages/gateway/src/demo/routes-strategies.ts` | 全部路由,在 `http-extra.ts` 占一行 |
| `packages/webui/src/pages/strategies.tsx` | `#/strategies` 页 |
| `packages/gateway/test/demo/strategies.test.ts` · `strategies-http.test.ts` · `backtest.test.ts` 尾部 | 测试 |

## 10. 还没做(下一轮的输入)

- **晋升门还不够硬。** 没有样本外/参数敏感度/Deflated Sharpe/trial_count,也没有费用、funding、滑点模型;`expectancy_r > 0` 这一条在 20 笔样本上几乎没有统计意义。真正要挡住的是「换个名字反复试同一个想法直到偶然成功」,现在挡不住。
- **`shadow` 状态没有运行时。** 影子模式(跟着实盘判断但只记不下单)还没实现,`shadow` 目前只是一个状态标签,和 `backtest` 在行为上没有区别。
- **`cooldown_bars` 没有执行点。** 它进了 `content_hash`、进了提示词,但引擎里没有「这条策略 N 根内不许再开」的闸;要么在 `gates.ts` 加一道,要么在 `runtime` 的候选过滤里做。
- **`checklist.required` 没有强制。** 清单缺项时证据行会写「不可得 —— 本次不得按本策略 PROPOSE」,但这只是**对模型说的话**,不是代码闸。应该在 `gates.ts` 加一道 `checklist_complete`:PROPOSE 引用的策略,它的必需证据必须都算得出来。
- **区间均值回归没有确定性触发。** 现图没有 `range_edge` 事件,它现在挂在 `fast_move / vol_spike / kline_close` 上,等于让模型看图猜「这算不算在区间边缘」。晋升前应当补一个纯函数触发器。
- **`vol_compression_expansion` 的「压缩后第一次扩张」没有状态。** 「第一次」需要记住上一次扩张在哪根,现在只有单根快照,靠规则文字约束模型。
- **`estimateBacktest` 的策略解析可以退化。** http.ts 的三参数调用不传 library,此时 `candidates_by_strategy` 用的是**内置定义**而不是库里的 head 版本 —— 对没被改过版本的 id 是对的,对改过的会算旧参数的触发集合(触发集合本身很少随版本变,所以影响有限)。想根治要在 http.ts 多传一个参数。
- **回测的每策略归属依赖模型自报。** `strategy_id` 是模型填的,`unattributed` 桶就是它没填的那些。代码没有独立判定「这一单其实符合哪条策略的形态」,所以归属统计有自报偏差。
- **归因没有去重。** 同一个问题在多次回测里会反复产生近似提案;记忆侧有 `content_hash` 精确去重,但措辞稍变就重复了。
- **`workflow.active_strategies` 的库校验是在读侧做的。** `applyWorkflowPatch` 是纯函数,只校验 id 形状;「存不存在 / 够不够 paper」由 `POST /api/strategies/active` 和 `buildContext` 前的 `resolve()` 把关。直接 `POST /api/workflow` 塞一个不存在的 id 不会报错,只会在判断时被静默过滤 + 一条 warn 日志。
