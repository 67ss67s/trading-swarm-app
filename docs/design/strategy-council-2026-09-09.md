# 策略议会:让策略层成为循环里独立的一步(2026-09-09)

Jacky 的原话:「策略判断目前只有突破回踩,能否让 strategy agent 变得更加 agentic,变成 loop 运行环里的一步,适配某些策略对应某个资产,然后多个策略都判断一样了再做交易(strategy 做完判断放回 thread 判断)」。

本文是实现说明与边界。代码:`packages/gateway/src/demo/strategy-council.ts`;接线:`runtime.ts`(执行 episode 的中段)、`context.ts`(证据 + 规则 9b/8c)、`graph.ts`(`strategy_consensus` 守卫)、`workflow.ts`(三个开关)、`types.ts`(`Episode.strategy_council`、`StrategyThread.council`)。测试 `test/demo/strategy-council.test.ts`(8 例)。

## 1. 改之前是什么样

一个 episode = **一次大脑调用**。被触发器唤醒的策略全部渲染进同一段 system prompt(`renderStrategies`),模型自己挑一条,PROPOSE 时填 `strategy_id`。后果:

- 「多条策略」在实现上只是 prompt 里的几段文字,没有任何一条策略**独立表过态**。谁同意谁反对不可知,自然也没有「都判断一样了再做」。
- 策略与资产的匹配只在 Radar 筛选那一刻发生(12h/72h/7d 一次),判断时不再进入证据。
- 线程建立后,当初那条策略是否还成立没人复核;复查只看价格结构(规则 8)。
- 现网 `active_strategies` 只有 `breakout_retest` 一条 —— 其余四条内置策略都停在 `backtest`,因为 `resolve(allow_below_paper:false)` 只放行 ≥ paper。所以「只有突破回踩」既是配置事实,也是没有独立表态机制的结果。

## 2. 改之后:议会是循环里的一步

```
触发器 → 拉行情/K线 → 【策略议会:每条策略各自表态 + 共识】 → 主判断(带议会证据)→ 代码闸(含策略共识)→ 意图 → 执行
                                    ↓
                            开仓时快照进线程 thread.council
                                    ↓
复查触发 → 重算当初同意方的裁决 → councilReview 对照 → 主判断(带「还同不同意」证据)→ 规则 8 边界
```

三层分工照抄仓库既有原则(代码算证据、模型只挑方向、模型不改数字):

| 层 | 谁做 | 产出 |
| --- | --- | --- |
| 裁决 verdict | **代码**(`STRATEGY_VERDICT` 注册表,按策略 id 注册纯函数);可选每策略再问一次模型 | `stance` = long / short / neutral / abstain + confidence + checks |
| 适配 fit | 代码(`strategyFit`) | Radar 候选分 / Lab 期望 / eval 期望 / 本币本策略历史,加权成 0–1 |
| 共识 consensus | 代码(`consensus`) | 同向票 ≥ `min_agree` 且无过线反向票 → reached |

### 裁决为什么默认是代码

`stance` 只有四个值,判据全是已经算好的确定性数字(`scanChecklist` 的趋势同向 / 追单距离 / 回踩确认 / ATR 门槛,加各策略自己的证据行)。让模型再念一遍不会更准,只会每策略多烧一次调用。所以默认零模型:`council_model='off'`。

想要模型票时(`cheap` / `main`)是**每条被唤醒的策略一次小调用**,只看这一条策略的证据,输出一个极小 JSON。合并规则 `mergeVerdict`:

- 代码弃权(该策略还没有裁决实现)→ 用模型票;
- 代码有方向、模型反向 → **中立**(冲突不硬来);
- 代码有方向、模型中立/弃权 → 保留方向,信心打七折;
- 同向 → 信心取均值。

这些调用不计入 `daily_judgment_cap`(那个 cap 数的是 episode),但确实花钱 —— 默认关着。

### 弃权不是反对

`abstain` 的两种来源:这次触发器没唤醒这条策略、或者这条策略还没有代码裁决实现。两种都**不计入票数**,也不算反对票。`min_agree` 会被钳到「能投票的策略数」:只有一条策略能投票时 `min_agree=2` 不该把交易永远锁死。

### 共识的口径

- 同向且 `confidence ≥ confidence_floor`(0.4)的票才算数;
- 有过线的反向票 → 直接判无共识(`策略方向冲突`),不做多数决;
- `reached = 同向票数 ≥ required`。

## 3. 三个开关(`workflow`,只有人能改)

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `strategy_council` | `advise` | `off` 旧行为;`advise` 算出来当证据不拦;`require` PROPOSE 必须有共识 |
| `council_min_agree` | `2` | 需要几条策略同向(1–4,钳到能投票数) |
| `council_model` | `off` | `off` 零模型;`cheap` 副脑;`main` 主脑,每策略一次调用 |

现网建议:先 `advise` + `off` 跑一段,看议会与实际 PROPOSE 的一致率,再决定要不要 `require`。**`require` 在只有一条策略够 paper 的当下等于把开仓门槛抬到「那一条策略自己同意」** —— 因为 `min_agree` 会被钳到 1。要真正做到「多条策略都同意」,得先把 `mtf_alignment` 等晋升到 paper。

## 4. 进证据与进 prompt 的样子

`context.ts` 新增两条 evidence(kind = `council`):

- 扫描:`策略议会(代码汇总)` = 共识与逐策略票面(`stance` / confidence / 适配分 / 首条理由)。
- 复查:`策略议会复核(代码计算)` = 开仓时同意的那几条现在仍同向几条、转中立几条、翻向几条。

规则:

- `9b`(require)= 共识=否不能 PROPOSE;共识=是时方向必须一致、`strategy_id` 必须在同意方里。advise 模式下 9b 是软的(参考它,反着来要写理由)。
- `8c` = 议会复核里的「翻向」是**结构证据之一**,可支持规则 8 ② 的离场判断,**不是硬离场线**。硬止损与失效确认的口径没变。

## 5. 代码闸

`graph.ts` 新增守卫 `strategy_consensus`,挂在 `scan.PROPOSE` 边上。`consensusGate` 只在 `require` 模式咬人:无议会结果 / 无共识 / 方向不一致 / `strategy_id` 不在同意方 → 拒。`advise` 与 `off` 永远通过(但闸会照常记进 `episode.gates`,所以事后能统计「如果开了 require 会拦掉多少」)。

## 6. 放回线程

开仓时 `thread.council = snapshotOf(结果)`:方向、是否达成、同意方、每票的 stance/confidence/fit。复查时:

- 复查议会的策略池 = **当初同意的那几条 + 线程钉住的策略**(不是当前所有启用策略),因为要回答的问题是「当初同意的现在还同不同意」;
- `councilReview` 对照快照与新裁决,输出 `still_agree / flipped / gone_neutral`。

## 7. 边界与已知空洞

- **只有两族策略有代码裁决**:`breakout_retest`(含 swing/position 变体)与 `mtf_alignment`。`vol_compression_expansion` / `funding_oi_extreme` / `range_mean_reversion` 目前一律弃权 —— 它们的证据行在 `STRATEGY_EVIDENCE` 里已经算好,裁决只差把数字变成 stance。
- 议会**没有独立的 eval**:现在没有任何数据证明「多策略共识」比单策略更赚。`advise` 模式先跑一段,拿 `episode.strategy_council` 与实际结果做事后统计,才谈得上开 `require`。
- 适配分的历史部分用「本币 × 本策略已结算线程的平均 R」,样本 < 5 时权重减半,但仍然是小样本 —— 别把它当作可靠信号。
- `fit` 只进证据与票面文本,**不进共识判定**(不按适配分加权投票)。这是刻意的:加权会让一条历史好看的策略压过其他票,而历史样本远不够。
- 模型票的 prompt 与解析是纯函数(`buildVerdictPrompt` / `parseVerdict`),但调用发生在 runtime,eval 目前不重放模型票。

## 8. 下一步顺序

1. 补三条策略的代码裁决 + 各自的数值场景测试。
2. 把 `mtf_alignment` 走完 backtest→shadow→paper(需要人批),否则 `require` 名不副实。
3. `advise` 模式跑满一周,统计:共识=是时 PROPOSE 的胜率 vs 共识=否时模型仍 PROPOSE 的胜率(后者在 advise 下不会被拦,正好是天然对照组)。
4. 议会结果进回放/eval 输入,让 `id@version` 回放也能重算票面。
