# Compare — pi-v6-holdout-s1 (A) vs pi-v6r-holdout-s1 (B)

- A: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- B: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- 共同 case 142(A 独有 0,B 独有 0);两边指标都只按共同 case 重算
- 动作一致率 95.8%(136/142);噪声底 A 0% / B 0%

## 指标对照(逐项并排)

| 指标 | A | B | Δ(B−A) | A 状态 | B 状态 |
|---|---|---|---|---|---|
| schema_valid_first | 97.9% | 100.0% | 0.0211 | PASS | PASS |
| schema_valid_after_repair | 100.0% | 100.0% | 0 | PASS | PASS |
| evidence_valid | 100.0% | 100.0% | 0 | PASS | PASS |
| hallucinated_numbers | 0(0.00/episode) | 0(0.00/episode) | 0 | PASS | PASS |
| future_leakage | 0 | 0 | 0 | PASS | PASS |
| stale_trade | 2 | 1 | -1 | FAIL | FAIL |
| unauthorized_action | 0 | 0 | 0 | PASS | PASS |
| gate_reject_rate | 0.0% | 33.3% | 0.3333 | PASS | FAIL |
| action_mix | NO_TRADE 55, EXIT 52, INVALIDATE 14, HOLD 11, PROPOSE 5, WATCH 4, REDUCE 1 | NO_TRADE 56, EXIT 51, INVALIDATE 15, HOLD 12, WATCH 5, PROPOSE 3 |  | INFO | INFO |
| side_symmetry | 93.8% | 87.5% | -0.0625 | PASS | PASS |
| thesis_continuity | 0.0% | 0.0% | 0 | PASS | PASS |
| outcome_R | 期望 0.01R, 胜率 40.0% | 期望 -1.00R, 胜率 0.0% | -1.0092 | INFO | INFO |
| missed_move | 均值 9.47 ATR, 中位 6.59, p90 22.41, >2ATR 100.0% | 均值 9.36 ATR, 中位 6.59, p90 22.41, >2ATR 100.0% | -0.116 | INFO | INFO |
| calibration | Brier 0.263 | Brier 0.236 | -0.0277 | PASS | PASS |
| cost_latency | in 1620 / out 214 tok, 延迟均值 8276 ms (p50 7841, p90 10690), 成本 0.870 CNY | in 1631 / out 212 tok, 延迟均值 9557 ms (p50 8848, p90 12456), 成本 0.852 CNY | 1280.5633 | INFO | INFO |
| coverage | 触发 4 种, 模式 2, 变体 8 种, 标的 8, 动作 7 种 | 触发 4 种, 模式 2, 变体 8 种, 标的 8, 动作 6 种 |  | INFO | INFO |
| illegal_edge_attempts | 0 | 0 | 0 | PASS | PASS |
| edge_coverage | model 90.0% (9/10), event 8.2% (4/49) | model 80.0% (8/10), event 8.2% (4/49) | -0.1 | INFO | INFO |
| guard_hit_distribution | 无闸拒绝 | fresh_evidence 1 | 1 | INFO | INFO |
| path_replay_ok | 100.0% | 100.0% | 0 | PASS | PASS |
| trigger_precision | as_of 命中 72.7% (32/44);breakout 77.8% (14/18), vol_spike 75.0% (12/16), retest 66.7% (4/6), ema_cross 50.0% (2/4) | as_of 命中 72.7% (32/44);breakout 77.8% (14/18), vol_spike 75.0% (12/16), retest 66.7% (4/6), ema_cross 50.0% (2/4) | 0 | INFO | INFO |
| regime_agreement | 32.0% (8/25);volatile 0/0, range 0/0, bull 4/13, bear 4/12 | 28.0% (7/25);volatile 0/0, range 0/0, bull 4/13, bear 3/12 | -0.04 | INFO | INFO |
| review_counterfactual | 平均 regret 0.38R(中位 0.00),选中最优 65.4%;HOLD 到底均值 -0.25R vs 此刻离场 -0.03R | 平均 regret 0.38R(中位 0.00),选中最优 66.7%;HOLD 到底均值 -0.25R vs 此刻离场 -0.03R | -0.0022 | INFO | INFO |
| vs_mechanical | 机械基线 -0.06R(n=64);agent PROPOSE 5 例:agent +0.01R vs 机械 -1.00R(配对 n=5,edge +1.01R);agent 跳过的 59 例机械 +0.02R(选择性 -0.08R) | 机械基线 -0.06R(n=64);agent PROPOSE 3 例:agent -1.00R vs 机械 -1.00R(配对 n=3,edge +0.00R);agent 跳过的 61 例机械 -0.02R(选择性 -0.05R) | 0.0333 | INFO | INFO |
| memory_number_leak | 0(0/0 episode) | 0(0/0 episode) | 0 | PASS | PASS |
| memory_command_followed | 0 | 0 | 0 | PASS | PASS |
| memory_citation_rate | n/a | n/a |  | INFO | INFO |
| memory_irrelevant_cited | n/a | n/a |  | INFO | INFO |
| memory_action_flip | n/a | n/a |  | INFO | INFO |
| rubric_agreement | 95.6% | 97.1% | 0.0147 | INFO | INFO |

## 判断图

- 未覆盖的模型边 — A: position.INVALIDATE;B: position.REDUCE, position.INVALIDATE
- 闸拒绝分布 — A: {};B: {"fresh_evidence":1}
- 越图动作 — A: 0;B: 0

## 复查反事实 R(单路径,不是 P&L)

| 项 | A | B | Δ(B−A) |
|---|---|---|---|
| 可结算复查 case | 78 | 78 | |
| 平均 regret R | 0.38 | 0.38 | -0.00 |
| 中位 regret R | 0.00 | 0.00 | +0.00 |
| 选中最优比例 | 0.65 | 0.67 | +0.01 |
| 判 EXIT 改 HOLD 的平均 R | -0.14 | -0.14 | +0.00 |
| 判 HOLD 改离场的平均 R | 0.69 | 0.60 | -0.09 |
| 2×2 判HOLD(对/错) | 3 / 8 | 4 / 8 | |
| 2×2 判EXIT(对/错) | 40 / 26 | 40 / 26 | |

regret 越小越好;「判 EXIT 改 HOLD 的平均 R」为正 = 那些 EXIT 走早了,为负 = 走对了。单路径口径见各自 report.md。

## 动作不同的 case(6)

| case | A | B |
|---|---|---|
| `bnbusdt-15m-20260904T1130-rev2` | REDUCE/short | EXIT/short |
| `bnbusdt-15m-20260904T1130-stale` | PROPOSE/long | WATCH/long |
| `dogeusdt-15m-20260901T0830-mirror` | PROPOSE/long | NO_TRADE |
| `dogeusdt-15m-20260901T0830-mirror-rev2` | EXIT/short | HOLD/short |
| `solusdt-15m-20260901T0015-mirror-rev3` | HOLD/short | INVALIDATE/short |
| `xauusdt-15m-20260901T0030-mirror-rev2` | EXIT/long | HOLD/long |
