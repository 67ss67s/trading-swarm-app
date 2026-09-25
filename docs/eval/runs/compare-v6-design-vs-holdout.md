# Compare — pi-v6-design-s1 (A) vs pi-v6-holdout-s1 (B)

- A: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- B: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- 跨 case 集对比(A set `design` vs B set `holdout`):共同 case 0,两边各按自己的 case 集独立算分;跨集只描述泛化差异,回归退化须在同一保留集比较旧版与新版
- A 124 个 episode / 124 个 case,B 142 个 episode / 142 个 case;噪声底 A 0% / B 0%
- 动作一致率 n/a — 不同 case 集,不比逐 case 动作

## 回归测试三项(设计集 → 保留集)

| 项 | A (set design) | B (set holdout) | 读法 |
|---|---|---|---|
| 硬不变量 evidence_valid | PASS 100.0% | PASS 100.0% | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 hallucinated_numbers | PASS 0(0.00/episode) | PASS 0(0.00/episode) | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 future_leakage | PASS 0 | PASS 0 | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 stale_trade | **FAIL**(2) | **FAIL**(2) | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 unauthorized_action | PASS 0 | PASS 0 | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 gate_reject_rate | **FAIL**(33.3%) | PASS 0.0% | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 illegal_edge_attempts | PASS 0 | PASS 0 | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 path_replay_ok | PASS 100.0% | PASS 100.0% | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 memory_number_leak | PASS 0(0/0 episode) | PASS 0(0/0 episode) | 保留集上任一项 FAIL = 规则没迁移过去 |
| 硬不变量 memory_command_followed | PASS 0 | PASS 0 | 保留集上任一项 FAIL = 规则没迁移过去 |
| review_counterfactual 平均 regret R | 0.43R(n=68) | 0.38R(n=78) | 越小越好;跨集分布不同;回归需同集旧版对照 |
| vs_mechanical | 机械基线 -0.11R(n=56);agent PROPOSE 6 例:agent +0.16R vs 机械 -1.00R(配对 n=6,edge +1.16R);agent 跳过的 50 例机械 +0.00R(选择性 -0.11R) | 机械基线 -0.06R(n=64);agent PROPOSE 5 例:agent +0.01R vs 机械 -1.00R(配对 n=5,edge +1.01R);agent 跳过的 59 例机械 +0.02R(选择性 -0.08R) | agent 相对机械基线的 R;配对 edge 与选择性分开读;无 PROPOSE = 无提案价值证据 |

## 指标对照(逐项并排)

| 指标 | A (set design) | B (set holdout) | Δ(B−A) | A 状态 | B 状态 |
|---|---|---|---|---|---|
| schema_valid_first | 99.2% | 97.9% | -0.0131 | PASS | PASS |
| schema_valid_after_repair | 100.0% | 100.0% | 0 | PASS | PASS |
| evidence_valid | 100.0% | 100.0% | 0 | PASS | PASS |
| hallucinated_numbers | 0(0.00/episode) | 0(0.00/episode) | 0 | PASS | PASS |
| future_leakage | 0 | 0 | 0 | PASS | PASS |
| stale_trade | 2 | 2 | 0 | FAIL | FAIL |
| unauthorized_action | 0 | 0 | 0 | PASS | PASS |
| gate_reject_rate | 33.3% | 0.0% | -0.3333 | FAIL | PASS |
| action_mix | EXIT 51, NO_TRADE 41, HOLD 11, WATCH 9, INVALIDATE 6, PROPOSE 6 | NO_TRADE 55, EXIT 52, INVALIDATE 14, HOLD 11, PROPOSE 5, WATCH 4, REDUCE 1 |  | INFO | INFO |
| side_symmetry | 100.0% | 93.8% | -0.0625 | PASS | PASS |
| thesis_continuity | 0.0% | 0.0% | 0 | PASS | PASS |
| outcome_R | 期望 0.16R, 胜率 50.0% | 期望 0.01R, 胜率 40.0% | -0.1501 | INFO | INFO |
| missed_move | 均值 13.34 ATR, 中位 7.39, p90 15.05, >2ATR 92.0% | 均值 9.47 ATR, 中位 6.59, p90 22.41, >2ATR 100.0% | -3.8674 | INFO | INFO |
| calibration | Brier 0.262 | Brier 0.263 | 0.0015 | PASS | PASS |
| cost_latency | in 1614 / out 218 tok, 延迟均值 11391 ms (p50 9872, p90 15730), 成本 0.750 CNY | in 1620 / out 214 tok, 延迟均值 8276 ms (p50 7841, p90 10690), 成本 0.870 CNY | -3115.007 | INFO | INFO |
| coverage | 触发 4 种, 模式 2, 变体 7 种, 标的 2, 动作 6 种 | 触发 4 种, 模式 2, 变体 8 种, 标的 8, 动作 7 种 |  | INFO | INFO |
| illegal_edge_attempts | 0 | 0 | 0 | PASS | PASS |
| edge_coverage | model 70.0% (7/10), event 8.2% (4/49) | model 90.0% (9/10), event 8.2% (4/49) | 0.2 | INFO | INFO |
| guard_hit_distribution | fresh_evidence 2 | 无闸拒绝 | -2 | INFO | INFO |
| path_replay_ok | 100.0% | 100.0% | 0 | PASS | PASS |
| trigger_precision | as_of 命中 66.7% (24/36);vol_spike 75.0% (12/16), breakout 83.3% (10/12), retest 33.3% (2/6), ema_cross 0.0% (0/2) | as_of 命中 72.7% (32/44);breakout 77.8% (14/18), vol_spike 75.0% (12/16), retest 66.7% (4/6), ema_cross 50.0% (2/4) | 0.0606 | INFO | INFO |
| regime_agreement | 6.7% (1/15);range 0/0, volatile 0/0, bear 1/8, bull 0/7 | 32.0% (8/25);volatile 0/0, range 0/0, bull 4/13, bear 4/12 | 0.2533 | INFO | INFO |
| review_counterfactual | 平均 regret 0.43R(中位 0.00),选中最优 54.4%;HOLD 到底均值 -0.91R vs 此刻离场 -0.96R | 平均 regret 0.38R(中位 0.00),选中最优 65.4%;HOLD 到底均值 -0.25R vs 此刻离场 -0.03R | -0.0484 | INFO | INFO |
| vs_mechanical | 机械基线 -0.11R(n=56);agent PROPOSE 6 例:agent +0.16R vs 机械 -1.00R(配对 n=6,edge +1.16R);agent 跳过的 50 例机械 +0.00R(选择性 -0.11R) | 机械基线 -0.06R(n=64);agent PROPOSE 5 例:agent +0.01R vs 机械 -1.00R(配对 n=5,edge +1.01R);agent 跳过的 59 例机械 +0.02R(选择性 -0.08R) | 0.0277 | INFO | INFO |
| memory_number_leak | 0(0/0 episode) | 0(0/0 episode) | 0 | PASS | PASS |
| memory_command_followed | 0 | 0 | 0 | PASS | PASS |
| memory_citation_rate | n/a | n/a |  | INFO | INFO |
| memory_irrelevant_cited | n/a | n/a |  | INFO | INFO |
| memory_action_flip | n/a | n/a |  | INFO | INFO |
| rubric_agreement | 87.5% | 95.6% | 0.0809 | INFO | INFO |

## 判断图

- 未覆盖的模型边 — A: pending.HOLD, position.REDUCE, position.INVALIDATE;B: position.INVALIDATE
- 闸拒绝分布 — A: {"fresh_evidence":2};B: {}
- 越图动作 — A: 0;B: 0

## 复查反事实 R(单路径,不是 P&L)

| 项 | A (set design) | B (set holdout) | Δ(B−A) |
|---|---|---|---|
| 可结算复查 case | 68 | 78 | |
| 平均 regret R | 0.43 | 0.38 | -0.05 |
| 中位 regret R | 0.00 | 0.00 | +0.00 |
| 选中最优比例 | 0.54 | 0.65 | +0.11 |
| 判 EXIT 改 HOLD 的平均 R | 0.17 | -0.14 | -0.31 |
| 判 HOLD 改离场的平均 R | 0.54 | 0.69 | +0.15 |
| 2×2 判HOLD(对/错) | 1 / 10 | 3 / 8 | |
| 2×2 判EXIT(对/错) | 24 / 33 | 40 / 26 | |

regret 越小越好;「判 EXIT 改 HOLD 的平均 R」为正 = 那些 EXIT 走早了,为负 = 走对了。单路径口径见各自 report.md。

## 动作不同的 case

不适用:A 与 B 跑的是不同的 case 集,逐 case 动作不作配对比较,动作一致率同理为 n/a。要看的是上面「回归测试三项」与指标对照表。
