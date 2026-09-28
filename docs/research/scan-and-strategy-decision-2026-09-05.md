# 扫描频率 / 交易倾向 / 策略构建:取舍与决定(2026-09-05)

> 对 Codex 两篇调研(`scan-frequency-and-bias-2026-09-05.md`、`strategy-construction-2026-09-05.md`)的裁定。原则:先用账本里的真数替掉推测,再决定做什么、不做什么。

## 1. 先把账算对:昨天 668 次判断花在哪

`demo_episodes` 2026-09-04 全天,按触发种类:

| 触发 | 次数 | 其中 WATCH | 其中 PROPOSE |
|---|---:|---:|---:|
| kline_close(每根收盘例行) | 590 | 412 | 1 |
| heartbeat(30 分钟心跳) | 42 | 38 | 0 |
| manual(手动/对话) | 12 | 12 | 0 |
| retest / vol_spike / ema_cross / breakout(真触发器) | 7 / 7 / 6 / 3 | 22 | 0 |
| order_filled | 1 | | |

token 合计 874,873 输入 / 161,269 输出;按 GLM-5.3 ¥2/M 入、¥8/M 出估算 ¥3.04 → **实测单价 ≈ ¥0.0045/次**,不是 Codex 表里用的 ¥0.006(它自己也标了这个缺口)。预算表里的金额按 0.75 折读。

结论比调研更直接:**88% 的钱花在 `kline_close` 上,真触发器只占 3.4%**,而且 590 次例行判断只产出 1 次 PROPOSE、412 次 WATCH。这不是"模型胆小",是我们每 15 分钟对 6 个币各问一遍"有没有机会",答案几乎永远是"再看看"。当天大部分时间 `scan_mode` 处在 `every_close`(showcase 预设),现在已是 `triggered` + 30 分钟心跳,但心跳仍是 6 币 × 48 次/天 = 288 次的底,≈ ¥1.3/天,问的还是同一个问题。

## 2. 采纳什么

**采纳 A:两层漏斗,心跳只在"指纹变了"时才花钱。** Codex 的 Tier 0/Tier 1 设计是对的,先做最便宜的一刀:心跳扫描前比较该币的指纹(15m/1h/4h 趋势方向、regime、是否在 EMA20 上、ATR% 分档、信息员市场状态版本、session),与上次调模型时相同 → 跳过并记一条 `heartbeat_skipped` 活动,不调模型。预期心跳从 288 次/天降到几十次。实现点:`runtime.ts onKlineClose` 的 `heartbeatDue` 分支加指纹比较;指纹由 `tfFeatures` 已有字段拼成,不新增行情请求。

**采纳 B:ATR% 门槛分周期。** 15m 用 0.4% 几乎不可能满足(零 PROPOSE 的根因之一),改为 15m 0.15% / 5m 0.08% / 1h 0.30%,写进 `review-metrics.ts` 的扫描清单而不是 playbook 文本,这样 eval 能直接回放。

**采纳 C:eval 的 case 生成按触发点抽 as_of。** 这是 trigger_precision 主口径样本为零的根因,也是判断"哪些触发值得付费"唯一可信的证据来源。在这之前,Codex 用"盘内重放 87%/86%"排触发优先级只能当方向性参考。

**采纳 D:定向验证 v4。** 30 个不稳定 case × 5 样本,≈150 次,按实测单价约 ¥0.7,12 分钟。看三个数:NO_TRADE↔WATCH 与 EXIT↔HOLD 的抖动是否收敛;action_mix 里 WATCH 是否被压到接近 0(那是把边界挪走不是降噪);missed_move 是否变差。

**采纳 E(策略构建):先加"多周期对齐"和"波动压缩→扩张"两个策略族。** 前者复用现有扫描清单,零新字段;后者只需 ATR/带宽的历史分位,一个数。资金费率/OI 极值排第三(OI 要接 `openInterestHist`)。区间边缘均值回归、session 效应、强平反转都要新证据源(深度、强平流、taker 不平衡),往后放。

**采纳 F(策略库模型):不可变版本对象 + 四道晋升门。** 触发(纯函数)+ 清单(必需证据)+ 规则(模型只能在给定边里选)+ 参数(范围锁定,改即换 hash)+ 评测统计。晋升 draft → backtest → shadow(≥200 次独立触发)→ paper → live_capped。长期记忆只能 propose。这与 `docs/design/trade-gate-design-v1-2026-09-02.md` §11 的"记忆不改数字"一致,直接作为下一阶段的数据模型。

## 3. 不采纳 / 往后放

- **不按 Codex 的判断预算网格定目标数。** 表里所有 ¥ 都基于未验证的单价与"每币 6–10 次"的推测;先做 A,一周后看账本再定。
- **不做 1m 级 Tier 0 的 mark 环形缓冲 fast_move 升级**(要 10 秒 tick 与 OI 变化,现有 `fast_move` 已有 10 秒轮询版本),等触发点抽样的 eval 证明 fast_move 有正期望再说。
- **不把 F&G/资金费率改成 z-score**——先用消融实验(只翻转这一项,看动作差异是否超 29.6% 噪声)证明它们真的在影响动作。
- **不做"多空偏差"的结论**。零 PROPOSE 之下 side_symmetry 100% 是空真;等 B、C 落地后镜像 case 有 PROPOSE 了再测。

## 4. 阅读清单的取舍(给 Jacky)

按对本项目的直接支撑排序,前三个就够先读:Lo–Mamaysky–Wang《Foundations of Technical Analysis》(把"形态"变成可检验的纯函数,正是触发器/清单的方法论);Bailey & López de Prado《The Deflated Sharpe Ratio》(多次试策略后的过拟合校正,对应晋升门的统计口径);Harris《Trading and Exchanges》(订单流、点差、冲击——我们只靠 K 线,这是最大盲区)。其余:Moskowitz–Ooi–Pedersen 时间序列动量(趋势延续的基线,但月度证据不能硬套分钟级)、White《Reality Check》、Cheng 等强平级联(fast_move 的理论依据)。开源里 freqtrade 的回测假设文档和 NautilusTrader"回测与实盘共用事件模型"值得对照我们的盲测引擎。

## 5. 执行顺序

1. A(心跳指纹)——半天,零模型成本,立刻省钱。
2. B(ATR 分周期)+ D(定向验证 v4)——一起跑一次 eval(¥0.7)。
3. C(触发点抽样 gen)——1 天,之后所有"哪个触发值得付费"的问题才有证据。
4. E/F——策略库数据模型设计稿,先设计后实现。
