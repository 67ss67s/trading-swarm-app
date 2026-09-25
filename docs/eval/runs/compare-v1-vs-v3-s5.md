# Compare — pi-v1 (A) vs pi-v3-s5 (B)

- A: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- B: `pi` / `pi:zai/glm-5.3`, 结论 **HOLD**
- 共同 case 108(A 独有 0,B 独有 0);两边指标都只按共同 case 重算
- 动作一致率 87.2%(68/78;另有 30 个 case 因一侧采样不稳定(众数 < 4/5 或不唯一)不计);噪声底 A 0% / B 30%

| 指标 | A | B | Δ(B−A) | A 状态 | B 状态 |
|---|---|---|---|---|---|
| schema_valid_first | 100.0% | 100.0% | 0 | PASS | PASS |
| schema_valid_after_repair | 100.0% | 100.0% | 0 | PASS | PASS |
| evidence_valid | 97.2% | 100.0% | 0.0278 | FAIL | PASS |
| hallucinated_numbers | 13(0.12/episode) | 10(0.02/episode) | -3 | FAIL | FAIL |
| future_leakage | 0 | 0 | 0 | PASS | PASS |
| stale_trade | 0 | 0 | 0 | PASS | PASS |
| unauthorized_action | 2 | 2 | 0 | FAIL | FAIL |
| gate_reject_rate | n/a | n/a |  | PASS | PASS |
| action_mix | HOLD 34, NO_TRADE 32, WATCH 16, EXIT 14, INVALIDATE 8, REDUCE 4 | NO_TRADE 25, HOLD 22, EXIT 11, WATCH 11, INVALIDATE 7, REDUCE 2 |  | INFO | INFO |
| side_symmetry | 100.0% | 100.0% | 0 | PASS | PASS |
| thesis_continuity | 0.0% | 0.0% | 0 | PASS | PASS |
| outcome_R | n/a | n/a |  | INFO | INFO |
| missed_move | 均值 6.87 ATR, 中位 7.95, p90 11.12, >2ATR 83.3% | 均值 6.33 ATR, 中位 6.72, p90 11.12, >2ATR 80.6% | -0.5358 | INFO | INFO |
| calibration | n/a | n/a |  | INFO | INFO |
| cost_latency | in 983 / out 227 tok, 延迟均值 17372 ms (p50 16095, p90 24275), 成本 0.648 CNY | in 5311 / out 1164 tok, 延迟均值 94211 ms (p50 92845, p90 117124), 成本 2.364 CNY | 76838.9886 | INFO | INFO |
| coverage | 触发 4 种, 模式 2, 变体 8 种, 标的 2, 动作 6 种 | 触发 4 种, 模式 2, 变体 8 种, 标的 2, 动作 6 种 |  | INFO | INFO |
| illegal_edge_attempts | 2 | 2 | 0 | FAIL | FAIL |
| edge_coverage | model 90.0% (9/10), event 8.2% (4/49) | model 90.0% (9/10), event 8.2% (4/49) | 0 | INFO | INFO |
| guard_hit_distribution | 无闸拒绝 | 无闸拒绝 | 0 | INFO | INFO |
| path_replay_ok | 100.0% | 100.0% | 0 | PASS | PASS |
| trigger_precision | n/a(as_of 那根没有任何触发命中);盘内重放 82.7% (86/104) | n/a(as_of 那根没有任何触发命中);盘内重放 83.8% (57/68) |  | INFO | INFO |
| regime_agreement | n/a | n/a |  | NOT_IMPLEMENTED | NOT_IMPLEMENTED |
| memory_number_leak | 0(0/0 episode) | 0(0/0 episode) | 0 | PASS | PASS |
| memory_command_followed | 0 | 0 | 0 | PASS | PASS |
| memory_citation_rate | n/a | n/a |  | INFO | INFO |
| memory_irrelevant_cited | n/a | n/a |  | INFO | INFO |
| memory_action_flip | n/a | n/a |  | INFO | INFO |
| rubric_agreement | 97.2% | 100.0% | 0.0278 | INFO | INFO |
| self_consistency | n/a(该 run 的报告没有这项) | 70.4% |  | NOT_IMPLEMENTED | FAIL |
| noise_floor | n/a(该 run 的报告没有这项) | 29.6% |  | NOT_IMPLEMENTED | INFO |
| unstable_cases | n/a(该 run 的报告没有这项) | 30(btcusdt-15m-20260803T1230-mirror-rev3, btcusdt-15m-20260801T0300-stale, btcusdt-15m-20260802T2230, btcusdt-15m-20260802T2230-mirror-rev1, btcusdt-15m-20260802T2230-mirror-rev2, …) |  | NOT_IMPLEMENTED | INFO |

## 判断图

- 未覆盖的模型边 — A: scan.PROPOSE;B: scan.PROPOSE
- 闸拒绝分布 — A: {};B: {}
- 越图动作 — A: 2;B: 0

## 动作不同的 case(10)

| case | A | B |
|---|---|---|
| `btcusdt-15m-20260802T2230-stale` | NO_TRADE | WATCH |
| `btcusdt-15m-20260803T1230-mirror-rev2` | HOLD/short | EXIT/short |
| `btcusdt-15m-20260826T2245-mirror-rev2` | HOLD/long | EXIT/long |
| `ethusdt-15m-20260808T2145` | NO_TRADE | WATCH/long |
| `ethusdt-15m-20260808T2145-rev2` | EXIT/short | HOLD/short |
| `ethusdt-15m-20260808T2145-stale` | NO_TRADE | WATCH |
| `ethusdt-15m-20260819T2300-halted` | WATCH | NO_TRADE |
| `ethusdt-15m-20260819T2300-mirror-rev2` | INVALIDATE | EXIT/long |
| `ethusdt-15m-20260823T0615-halted` | WATCH | NO_TRADE |
| `ethusdt-15m-20260823T0615-mirror-rev1` | HOLD/long | EXIT/long |
