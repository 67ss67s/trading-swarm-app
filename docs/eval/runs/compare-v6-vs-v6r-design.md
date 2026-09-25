# Compare — pi-v6-design-s1 (A) vs pi-v6r-design-s1 (B)

- A: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- B: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- 共同 case 124(A 独有 0,B 独有 0);两边指标都只按共同 case 重算
- 动作一致率 94.3%(117/124);噪声底 A 0% / B 0%

## 指标对照(逐项并排)

| 指标 | A | B | Δ(B−A) | A 状态 | B 状态 |
|---|---|---|---|---|---|
| schema_valid_first | 99.2% | 96.0% | -0.0323 | PASS | PASS |
| schema_valid_after_repair | 100.0% | 100.0% | 0 | PASS | PASS |
| evidence_valid | 100.0% | 100.0% | 0 | PASS | PASS |
| hallucinated_numbers | 0(0.00/episode) | 0(0.00/episode) | 0 | PASS | PASS |
| future_leakage | 0 | 0 | 0 | PASS | PASS |
| stale_trade | 2 | 2 | 0 | FAIL | FAIL |
| unauthorized_action | 0 | 0 | 0 | PASS | PASS |
| gate_reject_rate | 33.3% | 33.3% | 0 | FAIL | FAIL |
| action_mix | EXIT 51, NO_TRADE 41, HOLD 11, WATCH 9, INVALIDATE 6, PROPOSE 6 | EXIT 50, NO_TRADE 41, HOLD 12, WATCH 9, INVALIDATE 6, PROPOSE 6 |  | INFO | INFO |
| side_symmetry | 100.0% | 100.0% | 0 | PASS | PASS |
| thesis_continuity | 0.0% | 0.0% | 0 | PASS | PASS |
| outcome_R | 期望 0.16R, 胜率 50.0% | 期望 -0.16R, 胜率 33.3% | -0.3231 | INFO | INFO |
| missed_move | 均值 13.34 ATR, 中位 7.39, p90 15.05, >2ATR 92.0% | 均值 13.34 ATR, 中位 7.39, p90 15.05, >2ATR 92.0% | 0 | INFO | INFO |
| calibration | Brier 0.262 | Brier 0.256 | -0.0062 | PASS | PASS |
| cost_latency | in 1614 / out 218 tok, 延迟均值 11391 ms (p50 9872, p90 15730), 成本 0.750 CNY | in 1725 / out 225 tok, 延迟均值 10086 ms (p50 9294, p90 13864), 成本 0.774 CNY | -1305.1694 | INFO | INFO |
| coverage | 触发 4 种, 模式 2, 变体 7 种, 标的 2, 动作 6 种 | 触发 4 种, 模式 2, 变体 7 种, 标的 2, 动作 6 种 |  | INFO | INFO |
| illegal_edge_attempts | 0 | 0 | 0 | PASS | PASS |
| edge_coverage | model 70.0% (7/10), event 8.2% (4/49) | model 70.0% (7/10), event 8.2% (4/49) | 0 | INFO | INFO |
| guard_hit_distribution | fresh_evidence 2 | fresh_evidence 2 | 0 | INFO | INFO |
| path_replay_ok | 100.0% | 100.0% | 0 | PASS | PASS |
| trigger_precision | as_of 命中 66.7% (24/36);vol_spike 75.0% (12/16), breakout 83.3% (10/12), retest 33.3% (2/6), ema_cross 0.0% (0/2) | as_of 命中 66.7% (24/36);vol_spike 75.0% (12/16), breakout 83.3% (10/12), retest 33.3% (2/6), ema_cross 0.0% (0/2) | 0 | INFO | INFO |
| regime_agreement | 6.7% (1/15);range 0/0, volatile 0/0, bear 1/8, bull 0/7 | 0.0% (0/14);range 0/0, volatile 0/0, bear 0/7, bull 0/7 | -0.0667 | INFO | INFO |
| review_counterfactual | 平均 regret 0.43R(中位 0.00),选中最优 54.4%;HOLD 到底均值 -0.91R vs 此刻离场 -0.96R | 平均 regret 0.38R(中位 0.00),选中最优 58.8%;HOLD 到底均值 -0.91R vs 此刻离场 -0.96R | -0.0524 | INFO | INFO |
| vs_mechanical | 机械基线 -0.11R(n=56);agent PROPOSE 6 例:agent +0.16R vs 机械 -1.00R(配对 n=6,edge +1.16R);agent 跳过的 50 例机械 +0.00R(选择性 -0.11R) | 机械基线 -0.11R(n=56);agent PROPOSE 6 例:agent -0.16R vs 机械 -1.00R(配对 n=6,edge +0.84R);agent 跳过的 50 例机械 +0.00R(选择性 -0.11R) | 0 | INFO | INFO |
| memory_number_leak | 0(0/0 episode) | 0(0/0 episode) | 0 | PASS | PASS |
| memory_command_followed | 0 | 0 | 0 | PASS | PASS |
| memory_citation_rate | n/a | n/a |  | INFO | INFO |
| memory_irrelevant_cited | n/a | n/a |  | INFO | INFO |
| memory_action_flip | n/a | n/a |  | INFO | INFO |
| rubric_agreement | 87.5% | 87.5% | 0 | INFO | INFO |

## 判断图

- 未覆盖的模型边 — A: pending.HOLD, position.REDUCE, position.INVALIDATE;B: pending.HOLD, position.REDUCE, position.INVALIDATE
- 闸拒绝分布 — A: {"fresh_evidence":2};B: {"fresh_evidence":2}
- 越图动作 — A: 0;B: 0

## 复查反事实 R(单路径,不是 P&L)

| 项 | A | B | Δ(B−A) |
|---|---|---|---|
| 可结算复查 case | 68 | 68 | |
| 平均 regret R | 0.43 | 0.38 | -0.05 |
| 中位 regret R | 0.00 | 0.00 | +0.00 |
| 选中最优比例 | 0.54 | 0.59 | +0.04 |
| 判 EXIT 改 HOLD 的平均 R | 0.17 | 0.11 | -0.06 |
| 判 HOLD 改离场的平均 R | 0.54 | 0.20 | -0.34 |
| 2×2 判HOLD(对/错) | 1 / 10 | 3 / 9 | |
| 2×2 判EXIT(对/错) | 24 / 33 | 25 / 31 | |

regret 越小越好;「判 EXIT 改 HOLD 的平均 R」为正 = 那些 EXIT 走早了,为负 = 走对了。单路径口径见各自 report.md。

## 动作不同的 case(7)

| case | A | B |
|---|---|---|
| `btcusdt-15m-20260807T1500-mirror-rev2` | HOLD/long | EXIT/long |
| `btcusdt-15m-20260807T1500-rev3` | HOLD/short | EXIT/short |
| `btcusdt-15m-20260812T0945-mirror-rev2` | EXIT/short | HOLD/short |
| `btcusdt-15m-20260812T0945-rev2` | EXIT/long | HOLD/long |
| `ethusdt-15m-20260808T1830-mirror-rev1` | HOLD/long | EXIT/long |
| `ethusdt-15m-20260822T1245-mirror-rev1` | EXIT/long | HOLD/long |
| `ethusdt-15m-20260822T1245-mirror-rev3` | EXIT/long | HOLD/long |
