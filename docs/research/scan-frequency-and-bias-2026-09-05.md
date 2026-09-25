# 扫描频率、机会预算与判断偏差诊断（2026-09-05）

> 指标校正：精度与题设一致；报告实数是 `vol_spike` 85.7%（24/28）、`breakout` 87.0%（20/23）、`retest` 78.6%（11/14）、`ema_cross` 66.7%（2/3），同向最大位移均值分别为 **7.89、9.64、1.80、3.84 ATR**，所以 `breakout` 不是约 7–9 ATR，而是 9.64 ATR；盘内重放总精度为 83.8%（57/68）。

## 1. 扫描频率与机会捕获的量化分析

### 判断预算模型

令周期分钟数为 `T`、观察币数为 `N`、默认 heartbeat 为 `H=30` 分钟、额外急涨跌/成交/信息更新/人工事件为 `E_event`：

- 每币每日收盘数 `B=1440/T`；`every_close`：`J=N×B`。
- 现有 `triggered` 在 [`onKlineClose()`](../../packages/gateway/src/demo/runtime.ts) 中仍会逐币 heartbeat；不计额外事件时：`J=N×[min(B,1440/H), B]+E_event`。它是区间，因为触发会重置 heartbeat，且同一根只取最强 `TriggerHit` 唤醒一次。
- 成本外推统一用 `Cost=J×¥0.006`。今天实账约 ¥3；按此保守单价代理，668 次对应 ¥4.01，差异来自“约数/计价口径”，不反推改写已知实账。

参数网格（单元格为“判断数/成本”，`triggered` 未含 `E_event`）：

| 周期/模式 | 6 币 | 12 币 | 20 币 |
|---|---:|---:|---:|
| 1m every_close | 8,640 / ¥51.84 | 17,280 / ¥103.68 | 28,800 / ¥172.80 |
| 1m triggered | 288–8,640 / ¥1.73–51.84 | 576–17,280 / ¥3.46–103.68 | 960–28,800 / ¥5.76–172.80 |
| 5m every_close | 1,728 / ¥10.37 | 3,456 / ¥20.74 | 5,760 / ¥34.56 |
| 5m triggered | 288–1,728 / ¥1.73–10.37 | 576–3,456 / ¥3.46–20.74 | 960–5,760 / ¥5.76–34.56 |
| 15m every_close | 576 / ¥3.46 | 1,152 / ¥6.91 | 1,920 / ¥11.52 |
| 15m triggered | 288–576 / ¥1.73–3.46 | 576–1,152 / ¥3.46–6.91 | 960–1,920 / ¥5.76–11.52 |
| 1h every_close/triggered | 144 / ¥0.86 | 288 / ¥1.73 | 480 / ¥2.88 |

算例：6 币×15m `every_close=6×96=576` 次/日；现有 `triggered` 的收盘路径本应为 288–576 次，但今天达到 668 次，已高于纯扫描 576 次，说明 `E_event` 与无变化 heartbeat 不能再视为小项。12 币×5m 全问则是 3,456 次、¥20.74/日，规模不可取。另需注意当前 [`watchlist_max=8`](../../packages/gateway/src/demo/workflow.ts)；12/20 币是容量规划情景，不是当前配置可直接设置的值。

### 哪些触发值得付费

- `missed_move` 在 36 个稳定 NO_TRADE/WATCH 扫描样本上为均值 6.33 ATR、中位 6.72、p90 11.12，80.6% 超过 2 ATR：广泛“不交易”后确有大波动，但该指标取未来绝对最大位移，不给方向，不能当错失盈利。
- 优先付费给 `breakout` 与 `vol_spike`：盘内重放精度 87.0%/85.7%，位移 9.64/7.89 ATR。`retest` 精度仍有 78.6%，但均值仅 1.80 ATR，应要求更低成本、更严 R:R。`ema_cross` 只有 3 个样本，66.7% 不足以支持单独唤醒。
- 报告明确提醒“未来同向 ≥1 ATR”门槛偏低，83.8% 是波动筛中率而非胜率；`funding/session` 无方向而未评分，`fast_move` 缺 mark 环形缓冲而未评分，三者暂不应单独付 LLM 费。

### 两层漏斗与多周期链

「推测」参数 v0，必须先影子记录再晋升：

- Tier 0 永不调模型：10 秒 mark 环检测 `fast_move`；每根 1m 更新价格/保护距离；每根 5m 跑 `detectTriggers()`、去重和冷却；1h 另跑 swing 扫描。heartbeat 先比较“触发指纹、线程、账户、regime”是否变化，无变化即 0 token，落实设计稿 L-heartbeat。
- 日内链：5m 命中 → 15m 同方向结构 → 1h EMA20/50 确认 → 4h 只作强反向否决（反向且距 EMA 侧超过 1 ATR）；swing 链：1h `breakout/retest` → 4h 同向，5m 只择时。模型一次看到 5m/15m/1h/4h 与代码资格结论。
- ATR% 不再共用 0.4%：15m 先采用评测根因分析建议的 0.15%；「推测」5m/1h 初值 0.08%/0.30%，并与“本币×周期近 90 日第 20 分位”取较高者。
- `breakout`：沿用收盘越过前 20 根高/低，要求突破根量比 ≥1.5、距位 ≤1.5 ATR；`vol_spike`：沿用量比 ≥2 且实体 ≥0.6 ATR；两者冷却 30 分钟。
- `retest`：沿用距 EMA20 ≤0.3 ATR、近 5 根位移 ≥1 ATR，但须关联过去 12 根 5m 内的合格 breakout/spike；量比 ≥1.5 只检查原突破根，回踩根不设 ≥1.0；冷却 60 分钟。
- `ema_cross` 不单独升级，须 3 根内同时有 breakout/spike；冷却 4 小时。`funding`（现阈值 `|rate|≥0.05%`）与 `session` 只改上下文；`fast_move` 沿用 5 分钟 0.8%，但须同时有量比 ≥2 或「推测」`oi_change_1h_pct≤−3%` 才升级，冷却由现 10 分钟提高到 30 分钟。
- 每币每天软预算 10 次、硬预算 12 次；持仓硬止损/止盈由代码与交易所保护腿处理，LLM 只在 v4「持仓度量」跨越规则 8 边界时复查。

「推测」经过去重后的目标是每币 6–10 次/日，另留全局信息/异常 6–12 次：6 币 42–72 次、¥0.25–0.43（较 668 次少 89%–94%）；12 币 78–132 次、¥0.47–0.79；20 币 126–212 次、¥0.76–1.27。是否漏掉 swing 由 1h 独立通道和 `missed_move` 分层监控验证，不能靠放宽 heartbeat。

## 2. 交易倾向（bias）审计

下列“当前/观察到”数字来自 eval；各“纠正”是「推测」的待验证改法，不是已证明能提高收益的结论。

- **多头偏差。** 测量：按 symbol/regime/timeframe 分层比较 long/short `PROPOSE`、confidence、`outcome_R`；对镜像 case 跑 ≥3 样本并报 `side_symmetry`。当前 100% 仅 n=5 且零 PROPOSE，不能洗清偏差。纠正：把价格变化统一渲染为有符号、方向归一的 `trend_agree/dist_to_break_atr`，同一门槛同时约束多空，镜像失败阻断晋升。
- **动作偏差与已观察到的 NO_TRADE 偏差。** 测量：联读 `action_mix`、闸拒率、NO_TRADE/WATCH 的 `missed_move`、PROPOSE 的 `outcome_R`；按触发抽样，不能用均匀 as_of。当前稳定 scan 为 NO_TRADE 25/WATCH 11/PROPOSE 0，根因是 15m ATR 0.4%、回踩量比 1.0 与抽样方式，不是已证实的“模型胆小”。纠正：ATR 分周期、量比绑定原突破根，并在模型前提供 `qualifier_pass/reject_reasons`。
- **近因偏差。** 测量：保持 1h/4h 不变，只替换最后 1/3/5 根，比较 action flip、`thesis_continuity` 与校准；基线必须扣除 29.6% 采样噪声。纠正：新增 `trigger_age_bars/regime_age_bars`，规则写明单根 5m 不能推翻 1h/4h，除非同时满足 fast_move+vol_spike。
- **整数锚定。** 测量：统计 stop/TP 到 10/100/1000 整数、swing、EMA、ATR 候选的距离，并用 MAE/MFE、`outcome_R` 比较。纠正：模型只选 `stop_ref` 候选 ID，代码物化 `swing±ATR buffer`；数字先进入 Evidence Registry，禁止模型自由凑整。
- **止损过紧/过宽。** 测量：按 trigger/side/regime 画 `stop_distance_atr` 与 `stop_distance_pct` 分布，联读 stop-first、MAE/MFE、期望 R 和校准。纠正：证据增加 stop 距离 ATR/R、到 TP 的 R；沿用至少 0.8 ATR、volatile 至少 1.2 ATR，价格百分比 0.3%–5% 只作最终安全闸而非策略依据。
- **HOLD 与 EXIT 非对称。** 测量：review 镜像同动作率、`action_mix`、链式 `thesis_continuity`、EXIT 后反事实 R；v3 review self-consistency 仅 67.3%，EXIT↔HOLD 是 10 个不稳定 case 的主边界。纠正：保留 v4 `reviewMetrics()` 与规则 8；止损/失效已越过直接代码执行，LLM 不承担硬退出时钟。
- **做空犹豫。** 测量：在相同 ATR/量比/流动性镜像中比较 short 的 PROPOSE 率、confidence、止损宽度和触发到决策延迟；另报 short-only `side_symmetry`。纠正：流动性不足用 Gate v2 `做空流动性地板` 显式拒绝，流动性通过后不得在 prompt 再隐式加严；long/short 共用规则函数。
- **恐惧贪婪/资金费率过权。** 测量：只翻转 F&G 或 funding 的 counterfactual case，动作差异须显著超过 29.6% 噪声；再按 funding 分桶看 `outcome_R` 与 Brier `calibration`。纠正：`funding/session` 禁止单独升级；F&G 从入场 checklist 移为注释，funding 改为历史 z-score+方向拥挤度，并限制其只调 confidence，不覆盖结构证据。

## 3. 优先级实验清单

1. **P0 调用账本分解。** 给现有 trace 只读分析 raw hit、去重 hit、heartbeat、fast_move、review、info、manual 的次数与“最终可 PROPOSE”率；工程 0.5 天、模型增量 ¥0，跑 7 天。信号：解释 668 的 `E_event`，确定真正成本源。
2. **P0 触发点抽样与方向化回放。** gen 按 `detectTriggers` 抽 as_of，加入 1d；同时把 precision 从“同向 ≥1 ATR”升级为净优势 `MFE−MAE`、按费后 R 结算；工程 1–2 天、首轮模型 ¥0。信号：判断 85%+ 是否真实 edge 还是低门槛波动。
3. **P1 v4 定向确认。** 跑现成 30 个不稳定 case×5，约 150 调用、¥0.9、约 12 分钟。信号：NO_TRADE↔WATCH 12 例与 EXIT↔HOLD 10 例是否收敛，同时检查 `action_mix/missed_move`，防止只是把 WATCH 全压成 NO_TRADE。
4. **P1 两层漏斗影子周。** Tier 0 记录全部候选，只对预算内候选调用模型；工程 1–2 天；按 100 判断/日上限约 ¥4.2/周。信号：每 trigger 的 raw→qualified→PROPOSE→正 `outcome_R` 漏斗与实际 ¥/机会。
5. **P2 多空与信息消融包。** 30 组镜像/资金费率/F&G counterfactual×3 样本，共约 180 调用、¥1.08，工程 0.5 天。信号：方向差与信息字段影响是否超过 29.6% 噪声。
6. **P2 止损/退出网格。** 用相同 entry 回放 0.8/1.2/1.6 ATR 与 v4 EXIT 规则，含手续费、funding、同根 stop-first；工程 1 天、模型 ¥0。信号：按 strategy/regime 的 expectancy_R、MAE/MFE、回撤，产出候选而不直接改 live 参数。
