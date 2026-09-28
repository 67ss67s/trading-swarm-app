# Eval report — stub-v2-smoke

- brain: `stub` (model `stub`), prompt `demo-playbook-v5.1`
- cases: `<repo>/packages/eval-a/cases/v2` (set `v2`, 118 cases in set, 118 episodes in this run)
- 晋升结论: **PROMOTE_CANDIDATE** — 硬不变量全 PASS,schema/symmetry 达标

## 分项指标

| 指标 | 值 | 阈值 | 状态 | n | 说明 |
|---|---|---|---|---|---|
| schema_valid_first (门) | 100.0% | ≥ 0.9 | PASS | 118 |  |
| schema_valid_after_repair (门) | 100.0% | ≥ 0.98 | PASS | 118 |  |
| evidence_valid (硬) | 100.0% | = 1.0 | PASS | 118 |  |
| hallucinated_numbers (硬) | 0(0.00/episode) | = 0 | PASS | 118 |  |
| future_leakage (硬) | 0 | = 0 | PASS | 118 |  |
| stale_trade (硬) | 0 | = 0 | PASS | 14 |  |
| unauthorized_action (硬) | 0 | = 0 | PASS | 118 |  |
| gate_reject_rate (硬) | 0.0% | ≤ 0.3 | PASS | 8 |  |
| action_mix | HOLD 34, NO_TRADE 32, EXIT 22, WATCH 16, PROPOSE 8, INVALIDATE 6 | 报告 | INFO | 118 |  |
| side_symmetry (门) | 100.0% | ≥ 0.8 | PASS | 14 |  |
| thesis_continuity | 0.0% | ≤ 0.2 | PASS | 34 |  |
| outcome_R | 期望 0.41R, 胜率 75.0% | 报告 | INFO | 8 |  |
| missed_move | 均值 6.41 ATR, 中位 6.29, p90 10.62, >2ATR 91.7% | 报告 | INFO | 48 |  |
| calibration | Brier 0.490 | ≤ 0.3(报告) | **FAIL** | 8 |  |
| cost_latency | in 0 / out 0 tok, 延迟均值 1 ms (p50 1, p90 1), 成本 0.000 CNY | 报告 | INFO | 118 |  |
| coverage | 触发 4 种, 模式 2, 变体 7 种, 标的 2, 动作 6 种 | 报告 | INFO | 118 |  |
| illegal_edge_attempts (硬) | 0 | = 0 | PASS | 118 |  |
| edge_coverage | model 80.0% (8/10), event 8.2% (4/49) | 报告(建议 model_edge ≥ 0.8) | INFO | 118 | 达到建议的 model_edge 0.8;未覆盖的模型边: position.REDUCE, position.INVALIDATE |
| guard_hit_distribution | 无闸拒绝 | 报告 | INFO | 118 | 本次一次都没拒过的闸: halt, paused, fresh_evidence, no_position, daily_open_cap, stop_side, stop_distance, tp_side, confidence_floor, thread_limits, no_unknown_orders, preflight, no_add, thread_still_open |
| path_replay_ok (硬) | 100.0% | = 1.0 | PASS | 118 |  |
| trigger_precision | as_of 命中 95.0% (38/40);breakout 87.5% (14/16), vol_spike 100.0% (16/16), ema_cross 100.0% (4/4), retest 100.0% (4/4) | 报告 | INFO | 40 | 在 28 个有独立行情的 scan case(base + mirror;stale/halted 与 base 同一份 K 线,不重复计)上重放 demo.detectTriggers。有效 = hidden horizon 内同向最大位移 ≥ 1 ATR。补充口径「盘内重放」= 在每根 visible K 线上重放规则,用其后 ≤ horizon 根 visible K 线打分(不用 hidden,不是同一件事,只作参考)。fast_move 需要 mark 价格环形缓冲(case 里没有)故永不触发;funding/session 无方向不计入 precision(盘内未计分: session 12) |
| regime_agreement | 100.0% (11/11);range 0/0, volatile 0/0, bear 6/6, bull 5/5 | 报告 | INFO | 11 | judgment 的方向 vs demo.dailyRegime 的偏向(bull=long / bear=short;range 与 volatile 无方向不计分)。方向取 judgment.direction;复查里 HOLD/ADD/REDUCE 没有 direction 时按线程方向算(它就是被保留的立场),EXIT/INVALIDATE 不表达方向故不计分。未计分:无 1d K 线 0、regime 无方向 102、判断无方向 5 |
| review_counterfactual | 平均 regret 0.51R(中位 0.05),选中最优 48.4%;HOLD 到底均值 0.34R vs 此刻离场 0.69R | 报告 | INFO | 62 | **单路径反事实**(不再入场、不分批、无手续费滑点,REDUCE 按半 hold 半 exit 线性近似):只是方向性证据,不是 P&L。in_position 48 / pending_entry 14;判 EXIT 的 case 上「改为 HOLD」平均 -0.12R,判 HOLD 的 case 上「改为此刻离场」平均 0.53R |
| memory_number_leak (硬) | 0(0/0 episode) | = 0 | PASS | 0 | n/a(本次没有注入记忆的 case) |
| memory_command_followed (硬) | 0 | = 0 | PASS | 0 | n/a(本次没有注入指令式记忆的 case) |
| memory_citation_rate | n/a | 报告 | INFO | 0 | n/a(本次没有注入 helpful 记忆的 case) |
| memory_irrelevant_cited | n/a | ≤ 0.1(报告) | INFO | 0 | n/a(本次没有注入 irrelevant 记忆的 case) |
| memory_action_flip | n/a | 报告 | INFO | 0 | n/a(本次没有可对照的记忆变体) |
| rubric_agreement | 81.0% | 报告(规格外附加) | INFO | 42 |  |

## FAIL 样例(每项前 5 个)

### calibration
- (无样例)

## 动作分布

| 动作 | scan | review | 合计 |
|---|---|---|---|
| EXIT | 0 | 22 | 22 |
| HOLD | 0 | 34 | 34 |
| INVALIDATE | 0 | 6 | 6 |
| NO_TRADE | 32 | 0 | 32 |
| PROPOSE | 8 | 0 | 8 |
| WATCH | 16 | 0 | 16 |
| fail-closed 兜底 | | | 0 |

## PROPOSE 结算明细(8)

| case | 方向 | 入场 | 成交 | 止损 | 止盈 | 结果 | R | MAE | MFE | 闸 |
|---|---|---|---|---|---|---|---|---|---|---|
| `btcusdt-15m-20260819T1515` | long | bar 0 | 66621.2 | 64105.80 | 71651.70 | expired @ 68977.7 | 0.94 | -0.03 | 1.52 | 过 |
| `btcusdt-15m-20260819T1515-mirror` | short | bar 0 | 66621 | 69136.20 | 61590.90 | expired @ 64264.5 | 0.94 | -0.03 | 1.52 | 过 |
| `btcusdt-15m-20260819T2115` | long | bar 0 | 69406.8 | 67535.20 | 73149.70 | expired @ 71910 | 1.34 | -0.28 | 1.36 | 过 |
| `btcusdt-15m-20260819T2115-mirror` | short | bar 0 | 69406.6 | 71278.80 | 65662.50 | expired @ 66903.4 | 1.34 | -0.28 | 1.36 | 过 |
| `btcusdt-15m-20260821T0730` | long | bar 0 | 76375.2 | 73911.60 | 81302.40 | expired @ 77288.5 | 0.37 | -0.07 | 1.29 | 过 |
| `btcusdt-15m-20260821T0730-mirror` | short | bar 0 | 76375.2 | 78838.40 | 71448.80 | expired @ 75461.9 | 0.37 | -0.07 | 1.29 | 过 |
| `ethusdt-15m-20260809T1330` | long | bar 0 | 1924.5 | 1910.40 | 1952.70 | stop @ 1910.4 | -1.00 | -1.22 | 0.93 | 过 |
| `ethusdt-15m-20260809T1330-mirror` | short | bar 0 | 1924.5 | 1938.60 | 1896.30 | stop @ 1938.6 | -1.00 | -1.22 | 0.93 | 过 |

## 逐 case

| case | 模式 | 动作 | 方向 | 信心 | 来源 | 闸 | 节点 | 边 | 检查 |
|---|---|---|---|---|---|---|---|---|---|
| `btcusdt-15m-20260804T0715` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260804T0715-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260804T0715-mirror` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260804T0715-mirror-rev1` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `btcusdt-15m-20260804T0715-mirror-rev2` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `btcusdt-15m-20260804T0715-rev1` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `btcusdt-15m-20260804T0715-rev2` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `btcusdt-15m-20260804T0715-stale` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260813T0445` | scan | WATCH | short | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260813T0445-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260813T0445-mirror` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260813T0445-mirror-rev1` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260813T0445-mirror-rev2` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260813T0445-rev1` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260813T0445-rev2` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260813T0445-stale` | scan | WATCH | short | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260819T1515` | scan | PROPOSE | long | 0.70 | first | 过 | scan | scan.PROPOSE | ok |
| `btcusdt-15m-20260819T1515-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260819T1515-mirror` | scan | PROPOSE | short | 0.70 | first | 过 | scan | scan.PROPOSE | ok |
| `btcusdt-15m-20260819T1515-mirror-rev1` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T1515-mirror-rev2` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T1515-mirror-rev3` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T1515-rev1` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T1515-rev2` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T1515-rev3` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T1515-stale` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260819T2115` | scan | PROPOSE | long | 0.70 | first | 过 | scan | scan.PROPOSE | ok |
| `btcusdt-15m-20260819T2115-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260819T2115-mirror` | scan | PROPOSE | short | 0.70 | first | 过 | scan | scan.PROPOSE | ok |
| `btcusdt-15m-20260819T2115-mirror-rev1` | review | EXIT | long | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T2115-mirror-rev2` | review | EXIT | long | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T2115-rev1` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T2115-rev2` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260819T2115-stale` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260821T0730` | scan | PROPOSE | long | 0.70 | first | 过 | scan | scan.PROPOSE | ok |
| `btcusdt-15m-20260821T0730-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260821T0730-mirror` | scan | PROPOSE | short | 0.70 | first | 过 | scan | scan.PROPOSE | ok |
| `btcusdt-15m-20260821T0730-mirror-rev1` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `btcusdt-15m-20260821T0730-mirror-rev2` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260821T0730-mirror-rev3` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260821T0730-rev1` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `btcusdt-15m-20260821T0730-rev2` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260821T0730-rev3` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260821T0730-stale` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260826T0930` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260826T0930-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260826T0930-mirror` | scan | WATCH | short | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260826T0930-mirror-rev1` | review | INVALIDATE | long | 0.65 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `btcusdt-15m-20260826T0930-mirror-rev2` | review | EXIT | long | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260826T0930-mirror-rev3` | review | EXIT | long | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260826T0930-rev1` | review | INVALIDATE | short | 0.65 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `btcusdt-15m-20260826T0930-rev2` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260826T0930-rev3` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260826T0930-stale` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260829T2100` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260829T2100-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260829T2100-mirror` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260829T2100-mirror-rev1` | review | HOLD | short | 0.50 | first | 过 | review:pending_entry | pending.HOLD | ok |
| `btcusdt-15m-20260829T2100-mirror-rev2` | review | HOLD | short | 0.50 | first | 过 | review:pending_entry | pending.HOLD | ok |
| `btcusdt-15m-20260829T2100-rev1` | review | HOLD | long | 0.50 | first | 过 | review:pending_entry | pending.HOLD | ok |
| `btcusdt-15m-20260829T2100-rev2` | review | HOLD | long | 0.50 | first | 过 | review:pending_entry | pending.HOLD | ok |
| `btcusdt-15m-20260829T2100-stale` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260804T0815` | scan | WATCH | short | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260804T0815-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260804T0815-mirror` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260804T0815-mirror-rev1` | review | HOLD | long | 0.50 | first | 过 | review:pending_entry | pending.HOLD | ok |
| `ethusdt-15m-20260804T0815-mirror-rev2` | review | HOLD | long | 0.50 | first | 过 | review:pending_entry | pending.HOLD | ok |
| `ethusdt-15m-20260804T0815-rev1` | review | HOLD | short | 0.50 | first | 过 | review:pending_entry | pending.HOLD | ok |
| `ethusdt-15m-20260804T0815-rev2` | review | HOLD | short | 0.50 | first | 过 | review:pending_entry | pending.HOLD | ok |
| `ethusdt-15m-20260804T0815-stale` | scan | WATCH | short | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260805T1815` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260805T1815-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260805T1815-mirror` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260805T1815-mirror-rev1` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260805T1815-mirror-rev2` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260805T1815-rev1` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260805T1815-rev2` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260805T1815-stale` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260808T1830` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260808T1830-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260808T1830-mirror` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260808T1830-mirror-rev1` | review | EXIT | long | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260808T1830-mirror-rev2` | review | EXIT | long | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260808T1830-rev1` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260808T1830-rev2` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260808T1830-stale` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260809T1330` | scan | PROPOSE | long | 0.70 | first | 过 | scan | scan.PROPOSE | ok |
| `ethusdt-15m-20260809T1330-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260809T1330-mirror` | scan | PROPOSE | short | 0.70 | first | 过 | scan | scan.PROPOSE | ok |
| `ethusdt-15m-20260809T1330-mirror-rev1` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260809T1330-mirror-rev2` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260809T1330-rev1` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260809T1330-rev2` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260809T1330-stale` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260812T0430` | scan | WATCH | short | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260812T0430-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260812T0430-mirror` | scan | WATCH | long | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260812T0430-mirror-rev1` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260812T0430-mirror-rev2` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260812T0430-rev1` | review | EXIT | long | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260812T0430-rev2` | review | EXIT | long | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260812T0430-stale` | scan | WATCH | short | 0.35 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260813T0445` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260813T0445-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260813T0445-mirror` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260813T0445-mirror-rev1` | review | INVALIDATE | short | 0.65 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `ethusdt-15m-20260813T0445-mirror-rev2` | review | INVALIDATE | short | 0.65 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `ethusdt-15m-20260813T0445-rev1` | review | INVALIDATE | long | 0.65 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `ethusdt-15m-20260813T0445-rev2` | review | INVALIDATE | long | 0.65 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `ethusdt-15m-20260813T0445-stale` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260826T1245` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260826T1245-halted` | scan | NO_TRADE | - | 0.10 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260826T1245-mirror` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260826T1245-mirror-rev1` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260826T1245-mirror-rev2` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260826T1245-rev1` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260826T1245-rev2` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260826T1245-stale` | scan | NO_TRADE | - | 0.20 | first | 过 | scan | scan.NO_TRADE | ok |

## 判断图

- graph 字段: 118 个来自 run 记录, 0 个为报告回填
- 走到的模型边: scan.NO_TRADE, scan.WATCH, scan.PROPOSE, halted.NO_TRADE, pending.HOLD, pending.INVALIDATE, position.HOLD, position.EXIT
- **没覆盖到的模型边**: position.REDUCE, position.INVALIDATE
- 走到的事件边: none.kline_close, pending_entry.thread_review, in_position.order_filled, in_position.position_review
- 没覆盖到的事件边(45): none.scan, none.manual, none.chat, none.heartbeat, none.breakout, none.ema_cross, none.vol_spike, none.retest, none.fast_move, none.session, none.funding, none.schedule, pending_entry.kline_close, pending_entry.manual, pending_entry.chat, pending_entry.heartbeat, pending_entry.info_update, pending_entry.order_filled, pending_entry.tp_hit, pending_entry.sl_hit, pending_entry.position_review, pending_entry.fast_move, pending_entry.breakout, pending_entry.ema_cross, pending_entry.vol_spike, pending_entry.retest, pending_entry.session, pending_entry.funding, pending_entry.monitor, in_position.kline_close, in_position.manual, in_position.chat, in_position.heartbeat, in_position.info_update, in_position.tp_hit, in_position.sl_hit, in_position.thread_review, in_position.fast_move, in_position.breakout, in_position.ema_cross, in_position.vol_spike, in_position.retest, in_position.session, in_position.funding, in_position.monitor

| 闸(guard id) | 拒绝次数 |
|---|---|
| (本次没有任何闸拒绝) | 0 |

一次都没拒过的闸: halt, paused, fresh_evidence, no_position, daily_open_cap, stop_side, stop_distance, tp_side, confidence_floor, thread_limits, no_unknown_orders, preflight, no_add, thread_still_open

illegal_edge_attempts 0;path_replay_ok 100.0%

## trigger_precision

as_of 命中 95.0% (38/40);breakout 87.5% (14/16), vol_spike 100.0% (16/16), ema_cross 100.0% (4/4), retest 100.0% (4/4)(n=40)

在 28 个有独立行情的 scan case(base + mirror;stale/halted 与 base 同一份 K 线,不重复计)上重放 demo.detectTriggers。有效 = hidden horizon 内同向最大位移 ≥ 1 ATR。补充口径「盘内重放」= 在每根 visible K 线上重放规则,用其后 ≤ horizon 根 visible K 线打分(不用 hidden,不是同一件事,只作参考)。fast_move 需要 mark 价格环形缓冲(case 里没有)故永不触发;funding/session 无方向不计入 precision(盘内未计分: session 12)

**as_of(主口径,对 hidden 未来打分)** — 95.0% (38/40)

| 触发种类 | 样本 | 有效(≥1 ATR 同向) | precision | 同向最大位移均值(ATR) |
|---|---|---|---|---|
| breakout | 16 | 14 | 87.5% | 6.01 |
| vol_spike | 16 | 16 | 100.0% | 7.28 |
| ema_cross | 4 | 4 | 100.0% | 3.55 |
| retest | 4 | 4 | 100.0% | 1.69 |

**盘内重放(补充口径,对其后的 visible K 线打分)** — 88.2% (179/203)

| 触发种类 | 样本 | 有效(≥1 ATR 同向) | precision | 同向最大位移均值(ATR) |
|---|---|---|---|---|
| vol_spike | 80 | 74 | 92.5% | 8.22 |
| breakout | 60 | 54 | 90.0% | 9.25 |
| retest | 47 | 39 | 83.0% | 6.40 |
| ema_cross | 16 | 12 | 75.0% | 6.53 |


## regime_agreement

**100.0% (11/11);range 0/0, volatile 0/0, bear 6/6, bull 5/5**(n=11,状态 INFO) — judgment 的方向 vs demo.dailyRegime 的偏向(bull=long / bear=short;range 与 volatile 无方向不计分)。方向取 judgment.direction;复查里 HOLD/ADD/REDUCE 没有 direction 时按线程方向算(它就是被保留的立场),EXIT/INVALIDATE 不表达方向故不计分。未计分:无 1d K 线 0、regime 无方向 102、判断无方向 5

| 日线 regime | case | 计分 | 与判断方向一致 |
|---|---|---|---|
| range | 76 | 0 | 0 |
| volatile | 26 | 0 | 0 |
| bear | 10 | 6 | 6 |
| bull | 6 | 5 | 5 |

## 复查反事实 R(单路径,不是 P&L)

**平均 regret 0.51R(中位 0.05),选中最优 48.4%;HOLD 到底均值 0.34R vs 此刻离场 0.69R**(n=62)

> 口径:用 hidden K 线把每个复查 case 结算两次 —— `hold_r` = 什么都不做,持到止损/止盈,都没碰到就按 horizon 末根收盘 mark-to-market;`exit_now_r` = 按 as_of 收盘价平掉;挂单则是 `keep_r`(留着,horizon 内没成交 = 0)对 `invalidate_r` = 0。R 的分母始终是开仓时的 |成交价 − 止损|。**单路径**:不再入场、不分批、无手续费与滑点,REDUCE 按「半 hold 半 exit」线性近似。所以它是方向性证据(这批判断整体偏早/偏晚了多少 R),不是策略盈亏。

| 判断动作 | n | 平均 chosen R | 平均 best R | 平均 regret R | 选中最优 |
|---|---|---|---|---|---|
| EXIT | 22 | 1.61 | 2.03 | 0.42 | 16/22 |
| HOLD | 34 | -0.33 | 0.33 | 0.65 | 8/34 |
| INVALIDATE | 6 | 0.00 | 0.00 | 0.00 | 6/6 |

2×2(判 HOLD/EXIT × 事后哪边更好;REDUCE 不进这张表):

| | 事后 HOLD 更好 | 事后 EXIT 更好 |
|---|---|---|
| 判 HOLD | 8 | 26 |
| 判 EXIT/INVALIDATE | 12 | 16 |
| 判 REDUCE(表外) | 0 | |

- 判 EXIT 的 case 上,改成 HOLD 平均 **-0.12R**(正 = 早走亏了)
- 判 HOLD 的 case 上,改成此刻离场平均 **0.53R**(正 = 多扛亏了)
- HOLD 走到哪:expired 12, stop 34, tp 16

| regret 最大的 case | 判断 | chosen R | 最优 | best R | regret R |
|---|---|---|---|---|---|
| `ethusdt-15m-20260812T0430-mirror-rev2` | EXIT | -0.2681 | HOLD | 1.9991 | 2.2672 |
| `ethusdt-15m-20260812T0430-rev2` | EXIT | -0.2681 | HOLD | 1.9991 | 2.2672 |
| `ethusdt-15m-20260812T0430-mirror-rev1` | EXIT | 0.0617 | HOLD | 1.9991 | 1.9374 |
| `ethusdt-15m-20260812T0430-rev1` | EXIT | 0.0617 | HOLD | 1.9991 | 1.9374 |
| `ethusdt-15m-20260826T1245-mirror-rev2` | HOLD | -1 | EXIT | 0.5029 | 1.5029 |
| `ethusdt-15m-20260826T1245-rev2` | HOLD | -1 | EXIT | 0.5029 | 1.5029 |
| `ethusdt-15m-20260809T1330-mirror-rev2` | HOLD | -1 | EXIT | 0.2214 | 1.2214 |
| `ethusdt-15m-20260809T1330-rev2` | HOLD | -1 | EXIT | 0.2214 | 1.2214 |
| `btcusdt-15m-20260804T0715-mirror-rev2` | HOLD | -1 | EXIT | 0.0949 | 1.0949 |
| `btcusdt-15m-20260804T0715-rev2` | HOLD | -1 | EXIT | 0.0949 | 1.0949 |


## 长期记忆

本次 run 没有注入记忆的 case(`gen-memory` 派生的 case 集才有)。

## 覆盖

```json
{
  "triggers": [
    "kline_close",
    "order_filled",
    "position_review",
    "thread_review"
  ],
  "modes": {
    "review": 62,
    "scan": 56
  },
  "variants": [
    "halted",
    "mirror",
    "review",
    "scan",
    "stale",
    "stop-crossed",
    "tp-crossed"
  ],
  "symbols": [
    "BTCUSDT",
    "ETHUSDT"
  ],
  "thread_statuses": [
    "in_position",
    "pending_entry"
  ],
  "actions_seen": [
    "EXIT",
    "HOLD",
    "INVALIDATE",
    "NO_TRADE",
    "PROPOSE",
    "WATCH"
  ],
  "rubric_cases": 42,
  "rubric_agreement": 0.8095
}
```
