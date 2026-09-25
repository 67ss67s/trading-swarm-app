# 状态在每轮判断之间是怎么传的(2026-09-03)

一句话:**模型没有记忆,每一轮都是一次性的;记忆全部在数据库里,由代码决定「这一轮给模型看什么」。** 这是刻意的(评估文档 §5「share state, not raw context」),好处是每轮可回放、可测、换模型不换状态。

## 1. 三层状态

| 层 | 存哪 | 谁写 | 每轮怎么进模型 |
|---|---|---|---|
| **交易所事实**(持仓、挂单、成交、标记价) | 不存,每轮现拉(`backend.account()` / 公共行情) | 交易所 | 登记成证据 E<n>(账户段),带 observed_at;线程状态也由它重新推导 |
| **计划**(StrategyThread:论点、方向、入场区、止损、止盈、失效条件、下次要看的) | `demo_threads` 表 | 代码(模型只能通过判断的 patch 改论点 / 失效条件 / watch_conditions) | review 时整条线程渲染成「复查的线程」段;scan 时只说"本币无线程,其他线程 N 条" |
| **环境摘要**(信息员的 MarketState:regime、bias、要点、候选、风险事件、新闻) | `demo_market_states` 表 | 信息员(cheap brain) | 登记成证据(info 段),按自身年龄标 STALE;候选只是线索,提示明说不算理由 |

再加两样很轻的「上下文续接」:
- **上次对本币的判断一句话**(`last_judgment_summary`:时间 + action + headline),来自 `demo_episodes` 表——模型知道自己上次说了什么,但拿不到上次的完整推理。
- **playbook 文本**来自工作流设置(用户可改),是稳定前缀的一部分。

## 2. 一轮的顺序(`runtime.executeEpisode`)

1. 触发进入队列(同线程/同币去重,一次只跑一个)。
2. 现拉:K 线三周期、premiumIndex、OI 历史、24h、账户;算结构特征(纯函数)。
3. 从库里读:当前线程(review)/ 所有开放线程 / 最新 MarketState / 上次判断摘要 / playbook。
4. `buildContext` 把以上全部变成 E1..En 与一段 prompt,算 sha256 存进 episode(**模型看到的原文就是回放的原文**)。
5. 大脑输出 → 校验 → 修一次 → fail-closed。
6. 判断进 reducer:scan 的 PROPOSE 走闸 → 建线程;review 的 HOLD/REDUCE/EXIT/INVALIDATE 走 `reduceReview` → 只改允许的字段、触发允许的效果。
7. 线程 + episode 落库;下一轮从库里读到的就是这一轮留下的计划。

## 3. 状态**不**做的事

- 不把上一轮的 reasons / thesis 原文喂回去(防止自我强化);只给一句摘要。
- 不让模型改数量、杠杆、风险、线程状态(状态由交易所事实推导)。
- 不跨币共享上下文:BTC 的判断看不到 ETH 的证据,只知道"有其他线程"。
- 对话主会话是另一个东西:它有最近 14 条消息的滚动窗口 + 一段当前状态摘要,每轮重新注入;它也不持有判断链的记忆,想知道"为什么"要调 `get_thread` 读记录。

## 4. 这个设计对 eval 的意义

因为每轮的输入 = (visible 事实, 线程, MarketState, 上次摘要, playbook),eval 只要把这五样冻结成 case 就能离线重放;外部评审/评估文档要求的「无未来泄漏」也变成一句可检查的话:visible 里所有时间戳 ≤ as_of。规格在 `docs/eval/README.md`。
