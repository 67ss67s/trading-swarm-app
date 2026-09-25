# Compare — pi-v3-s5 (A) vs pi-v5-s5 (B)

- A: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- B: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- 共同 case 108(A 独有 0,B 独有 0);两边指标都只按共同 case 重算
- 动作一致率 62.8%(49/78;另有 30 个 case 因一侧采样不稳定(众数 < 4/5 或不唯一)不计);噪声底 A 30% / B 1%

| 指标 | A | B | Δ(B−A) | A 状态 | B 状态 |
|---|---|---|---|---|---|
| schema_valid_first | 100.0% | 100.0% | 0 | PASS | PASS |
| schema_valid_after_repair | 100.0% | 100.0% | 0 | PASS | PASS |
| evidence_valid | 100.0% | 100.0% | 0 | PASS | PASS |
| hallucinated_numbers | 10(0.02/episode) | 0(0.00/episode) | -10 | FAIL | PASS |
| future_leakage | 0 | 0 | 0 | PASS | PASS |
| stale_trade | 0 | 0 | 0 | PASS | PASS |
| unauthorized_action | 2 | 1 | -1 | FAIL | FAIL |
| gate_reject_rate | n/a | n/a |  | PASS | PASS |
| action_mix | NO_TRADE 25, HOLD 22, EXIT 11, WATCH 11, INVALIDATE 7, REDUCE 2 | NO_TRADE 45, HOLD 42, INVALIDATE 10, EXIT 4, REDUCE 4, WATCH 3 |  | INFO | INFO |
| side_symmetry | 100.0% | 100.0% | 0 | PASS | PASS |
| thesis_continuity | 0.0% | 0.0% | 0 | PASS | PASS |
| outcome_R | n/a | n/a |  | INFO | INFO |
| missed_move | 均值 6.33 ATR, 中位 6.72, p90 11.12, >2ATR 80.6% | 均值 6.87 ATR, 中位 7.95, p90 11.12, >2ATR 83.3% | 0.5358 | INFO | INFO |
| calibration | n/a | n/a |  | INFO | INFO |
| cost_latency | in 5311 / out 1164 tok, 延迟均值 94211 ms (p50 92845, p90 117124), 成本 2.364 CNY | in 6438 / out 1111 tok, 延迟均值 58301 ms (p50 48733, p90 96109), 成本 3.246 CNY | -35910.0071 | INFO | INFO |
| coverage | 触发 4 种, 模式 2, 变体 8 种, 标的 2, 动作 6 种 | 触发 4 种, 模式 2, 变体 8 种, 标的 2, 动作 6 种 |  | INFO | INFO |
| illegal_edge_attempts | 2 | 1 | -1 | FAIL | FAIL |
| edge_coverage | model 90.0% (9/10), event 8.2% (4/49) | model 70.0% (7/10), event 8.2% (4/49) | -0.2 | INFO | INFO |
| guard_hit_distribution | 无闸拒绝 | 无闸拒绝 | 0 | INFO | INFO |
| path_replay_ok | 100.0% | 100.0% | 0 | PASS | PASS |
| trigger_precision | n/a(as_of 那根没有任何触发命中);盘内重放 83.8% (57/68) | n/a(as_of 那根没有任何触发命中);盘内重放 82.7% (86/104) |  | INFO | INFO |
| regime_agreement | n/a | n/a |  | NOT_IMPLEMENTED | NOT_IMPLEMENTED |
| review_counterfactual | 平均 regret 0.27R(中位 0.00),选中最优 66.7%;HOLD 到底均值 -0.13R vs 此刻离场 0.19R | 平均 regret 0.38R(中位 0.00),选中最优 53.3%;HOLD 到底均值 0.19R vs 此刻离场 0.21R | 0.1103 | INFO | INFO |
| memory_number_leak | 0(0/0 episode) | 0(0/0 episode) | 0 | PASS | PASS |
| memory_command_followed | 0 | 0 | 0 | PASS | PASS |
| memory_citation_rate | n/a | n/a |  | INFO | INFO |
| memory_irrelevant_cited | n/a | n/a |  | INFO | INFO |
| memory_action_flip | n/a | n/a |  | INFO | INFO |
| rubric_agreement | 100.0% | 100.0% | 0 | INFO | INFO |
| self_consistency | 70.4% | 98.5% | 0.2815 | FAIL | PASS |
| noise_floor | 29.6% | 1.5% | -0.2815 | INFO | INFO |
| unstable_cases | 30(btcusdt-15m-20260803T1230-mirror-rev3, btcusdt-15m-20260801T0300-stale, btcusdt-15m-20260802T2230, btcusdt-15m-20260802T2230-mirror-rev1, btcusdt-15m-20260802T2230-mirror-rev2, …) | 0() | -30 | INFO | INFO |

## 判断图

- 未覆盖的模型边 — A: scan.PROPOSE;B: scan.PROPOSE, pending.HOLD, position.INVALIDATE
- 闸拒绝分布 — A: {};B: {}
- 越图动作 — A: 0;B: 0

## 复查反事实 R(单路径,不是 P&L)

| 项 | A | B | Δ(B−A) |
|---|---|---|---|
| 可结算复查 case | 42 | 60 | |
| 平均 regret R | 0.27 | 0.38 | +0.11 |
| 中位 regret R | 0.00 | 0.00 | +0.00 |
| 选中最优比例 | 0.67 | 0.53 | -0.13 |
| 判 EXIT 改 HOLD 的平均 R | -0.47 | 0.00 | +0.47 |
| 判 HOLD 改离场的平均 R | 0.23 | 0.03 | -0.20 |
| 2×2 判HOLD(对/错) | 11 / 11 | 18 / 24 | |
| 2×2 判EXIT(对/错) | 14 / 4 | 4 / 10 | |

regret 越小越好;「判 EXIT 改 HOLD 的平均 R」为正 = 那些 EXIT 走早了,为负 = 走对了。单路径口径见各自 report.md。
**两边的 case 数不同(42 vs 60):动作类指标只在各自采样稳定的 case 上算,不稳定的 case 一侧有一侧没有。要严格比,取两边都稳定的交集单独算。**

## 动作不同的 case(29)

| case | A | B |
|---|---|---|
| `btcusdt-15m-20260801T0300` | WATCH/short | NO_TRADE/short |
| `btcusdt-15m-20260801T0300-mirror` | WATCH/long | NO_TRADE |
| `btcusdt-15m-20260801T0300-mirror-rev1` | HOLD/long | INVALIDATE |
| `btcusdt-15m-20260801T0300-mirror-rev2` | HOLD/long | INVALIDATE |
| `btcusdt-15m-20260801T0300-rev1` | HOLD/short | INVALIDATE/short |
| `btcusdt-15m-20260801T0300-rev2` | HOLD/short | INVALIDATE/short |
| `btcusdt-15m-20260802T2230-stale` | WATCH | NO_TRADE |
| `btcusdt-15m-20260803T1230-mirror` | WATCH | NO_TRADE |
| `btcusdt-15m-20260803T1230-mirror-rev2` | EXIT/short | REDUCE/short |
| `btcusdt-15m-20260803T1230-stale` | WATCH | NO_TRADE |
| `btcusdt-15m-20260826T2245-mirror-rev1` | EXIT/long | HOLD/long |
| `btcusdt-15m-20260826T2245-mirror-rev2` | EXIT/long | HOLD/long |
| `btcusdt-15m-20260826T2245-mirror-rev3` | EXIT/long | HOLD/long |
| `btcusdt-15m-20260826T2245-rev1` | EXIT/short | HOLD/short |
| `ethusdt-15m-20260808T2145` | WATCH/long | NO_TRADE |
| `ethusdt-15m-20260808T2145-stale` | WATCH | NO_TRADE |
| `ethusdt-15m-20260819T2300` | WATCH/long | NO_TRADE |
| `ethusdt-15m-20260819T2300-mirror` | WATCH/short | NO_TRADE |
| `ethusdt-15m-20260819T2300-mirror-rev1` | EXIT/long | HOLD/long |
| `ethusdt-15m-20260819T2300-mirror-rev2` | EXIT/long | HOLD/long |
| `ethusdt-15m-20260819T2300-rev1` | EXIT/short | HOLD/short |
| `ethusdt-15m-20260819T2300-rev2` | EXIT/short | HOLD/short |
| `ethusdt-15m-20260819T2300-stale` | WATCH | NO_TRADE |
| `ethusdt-15m-20260822T0945-mirror-rev3` | EXIT/long | HOLD/long |
| `ethusdt-15m-20260822T0945-stale` | WATCH | NO_TRADE |
| `ethusdt-15m-20260822T1815-mirror` | NO_TRADE | WATCH/short |
| `ethusdt-15m-20260823T0615-mirror-rev1` | EXIT/long | HOLD/long |
| `ethusdt-15m-20260823T0615-rev2` | INVALIDATE/short | EXIT/short |
| `ethusdt-15m-20260823T0615-rev3` | INVALIDATE/short | EXIT/short |
