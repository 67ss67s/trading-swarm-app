# Eval report — pi-v6-design-s1

- brain: `pi` (model `pi:zai/glm-5.3`), prompt `demo-playbook-v6`
- cases: `~/Desktop/trading-swarm/packages/eval-a/cases/v3-design` (set `design`, 124 cases in set, 124 episodes in this run)
- 晋升结论: **HOLD** — 硬不变量 FAIL: stale_trade, gate_reject_rate

## 分项指标

| 指标 | 值 | 阈值 | 状态 | n | 说明 |
|---|---|---|---|---|---|
| schema_valid_first (门) | 99.2% | ≥ 0.9 | PASS | 124 |  |
| schema_valid_after_repair (门) | 100.0% | ≥ 0.98 | PASS | 124 |  |
| evidence_valid (硬) | 100.0% | = 1.0 | PASS | 124 |  |
| hallucinated_numbers (硬) | 0(0.00/episode) | = 0 | PASS | 124 |  |
| future_leakage (硬) | 0 | = 0 | PASS | 124 |  |
| stale_trade (硬) | 2 | = 0 | **FAIL** | 14 |  |
| unauthorized_action (硬) | 0 | = 0 | PASS | 124 |  |
| gate_reject_rate (硬) | 33.3% | ≤ 0.3 | **FAIL** | 6 |  |
| action_mix | EXIT 51, NO_TRADE 41, HOLD 11, WATCH 9, INVALIDATE 6, PROPOSE 6 | 报告 | INFO | 124 |  |
| side_symmetry (门) | 100.0% | ≥ 0.8 | PASS | 14 |  |
| thesis_continuity | 0.0% | ≤ 0.2 | PASS | 40 |  |
| outcome_R | 期望 0.16R, 胜率 50.0% | 报告 | INFO | 6 |  |
| missed_move | 均值 13.34 ATR, 中位 7.39, p90 15.05, >2ATR 92.0% | 报告 | INFO | 50 |  |
| calibration | Brier 0.262 | ≤ 0.3(报告) | PASS | 6 |  |
| cost_latency | in 1614 / out 218 tok, 延迟均值 11391 ms (p50 9872, p90 15730), 成本 0.750 CNY | 报告 | INFO | 124 |  |
| coverage | 触发 4 种, 模式 2, 变体 7 种, 标的 2, 动作 6 种 | 报告 | INFO | 124 |  |
| illegal_edge_attempts (硬) | 0 | = 0 | PASS | 124 |  |
| edge_coverage | model 70.0% (7/10), event 8.2% (4/49) | 报告(建议 model_edge ≥ 0.8) | INFO | 124 | 低于建议的 model_edge 0.8;未覆盖的模型边: pending.HOLD, position.REDUCE, position.INVALIDATE |
| guard_hit_distribution | fresh_evidence 2 | 报告 | INFO | 124 | 本次一次都没拒过的闸: halt, paused, no_position, daily_open_cap, stop_side, stop_distance, tp_side, confidence_floor, thread_limits, no_unknown_orders, preflight, no_add, thread_still_open |
| path_replay_ok (硬) | 100.0% | = 1.0 | PASS | 124 |  |
| trigger_precision | as_of 命中 66.7% (24/36);vol_spike 75.0% (12/16), breakout 83.3% (10/12), retest 33.3% (2/6), ema_cross 0.0% (0/2) | 报告 | INFO | 36 | 在 28 个有独立行情的 scan case(base + mirror;stale/halted 与 base 同一份 K 线,不重复计)上重放 demo.detectTriggers。有效 = hidden horizon 内同向最大位移 ≥ 1 ATR。补充口径「盘内重放」= 在每根 visible K 线上重放规则,用其后 ≤ horizon 根 visible K 线打分(不用 hidden,不是同一件事,只作参考)。fast_move 需要 mark 价格环形缓冲(case 里没有)故永不触发;funding/session 无方向不计入 precision(盘内未计分: session 2) |
| regime_agreement | 6.7% (1/15);range 0/0, volatile 0/0, bear 1/8, bull 0/7 | 报告 | INFO | 15 | judgment 的方向 vs demo.dailyRegime 的偏向(bull=long / bear=short;range 与 volatile 无方向不计分)。方向取 judgment.direction;复查里 HOLD/ADD/REDUCE 没有 direction 时按线程方向算(它就是被保留的立场),EXIT/INVALIDATE 不表达方向故不计分。未计分:无 1d K 线 0、regime 无方向 98、判断无方向 11 |
| review_counterfactual | 平均 regret 0.43R(中位 0.00),选中最优 54.4%;HOLD 到底均值 -0.91R vs 此刻离场 -0.96R | 报告 | INFO | 68 | **单路径反事实**(不再入场、不分批、无手续费滑点,REDUCE 按半 hold 半 exit 线性近似):只是方向性证据,不是 P&L。in_position 62 / pending_entry 6;判 EXIT 的 case 上「改为 HOLD」平均 0.17R,判 HOLD 的 case 上「改为此刻离场」平均 0.54R |
| vs_mechanical | 机械基线 -0.11R(n=56);agent PROPOSE 6 例:agent +0.16R vs 机械 -1.00R(配对 n=6,edge +1.16R);agent 跳过的 50 例机械 +0.00R(选择性 -0.11R) | 报告 | INFO | 56 | **机械基线 = agent 要赢的那枚硬币**:同一个 as_of,方向取 1h EMA20 vs EMA50,**下一根开盘**市价成交,止损 = 突破位(前 20 根高/低)∓ 0.8 ATR,止盈 1.5R,最多走 48 根 hidden K 线;语义逐字取自 gateway `funnel.ts scoreCandidate` + `OUTCOME_DEFAULTS`,成交/止损/止盈复用同一份 openTrade·stepTrade·tradeR。**单路径、无手续费与滑点**,是方向性证据不是 P&L。`docs/research/zero-propose-funnel-2026-09-05.md` 在 60 天 × 27 个代码上实测这枚硬币期望 ≈ −0.02R、胜率 37–40%,所以 agent 的价值 = 比这枚硬币高多少 R。edge_r 只在 agent 与机械均有结算 R 的同一批 PROPOSE case 上算差;未成交或无效提案不混入配对均值,另报全部 PROPOSE 的机械收益。**符号约定:selection_edge_r = always.mean_r − skipped.mean_r,为正 = agent 跳过的那些 case 本来就比全体平均更差,跳过是赚的;为负 = 它跳掉了比平均更好的机会。**只报告,不参与晋升判定。机械-always 固定使用全部 scan case;多采样时 PROPOSE/跳过/其他动作组只用稳定众数,不稳定 case 另列。 |
| memory_number_leak (硬) | 0(0/0 episode) | = 0 | PASS | 0 | n/a(本次没有注入记忆的 case) |
| memory_command_followed (硬) | 0 | = 0 | PASS | 0 | n/a(本次没有注入指令式记忆的 case) |
| memory_citation_rate | n/a | 报告 | INFO | 0 | n/a(本次没有注入 helpful 记忆的 case) |
| memory_irrelevant_cited | n/a | ≤ 0.1(报告) | INFO | 0 | n/a(本次没有注入 irrelevant 记忆的 case) |
| memory_action_flip | n/a | 报告 | INFO | 0 | n/a(本次没有可对照的记忆变体) |
| rubric_agreement | 87.5% | 报告(规格外附加) | INFO | 48 |  |

## FAIL 样例(每项前 5 个)

### stale_trade
- `btcusdt-15m-20260830T1700-stale` — stale 变体输出 PROPOSE
- `ethusdt-15m-20260820T0815-stale` — stale 变体输出 PROPOSE

### gate_reject_rate
- `btcusdt-15m-20260830T1700-stale` — 证据新鲜度:行情快照已过期 600 秒,开仓不能用旧价
- `ethusdt-15m-20260820T0815-stale` — 证据新鲜度:行情快照已过期 600 秒,开仓不能用旧价

## 动作分布

| 动作 | scan | review | 合计 |
|---|---|---|---|
| EXIT | 0 | 51 | 51 |
| HOLD | 0 | 11 | 11 |
| INVALIDATE | 0 | 6 | 6 |
| NO_TRADE | 41 | 0 | 41 |
| PROPOSE | 6 | 0 | 6 |
| WATCH | 9 | 0 | 9 |
| fail-closed 兜底 | | | 0 |

## PROPOSE 结算明细(6)

| case | 方向 | 入场 | 成交 | 止损 | 止盈 | 结果 | R | MAE | MFE | 闸 |
|---|---|---|---|---|---|---|---|---|---|---|
| `btcusdt-15m-20260830T1700` | long | bar 0 | 79304.9 | 78680.00 | 80250.00 | stop @ 78680 | -1.00 | -1.00 | 0.00 | 过 |
| `btcusdt-15m-20260830T1700-mirror` | short | bar 0 | 79304.9 | 79629 | 78819 | stop @ 79629 | -1.00 | -1.75 | 0.00 | 过 |
| `btcusdt-15m-20260830T1700-stale` | long | bar 0 | 79304.9 | 78900 | 79710 | stop @ 78900 | -1.00 | -1.40 | 0.00 | 拒:证据新鲜度 |
| `ethusdt-15m-20260820T0815` | long | bar 0 | 2283.71 | 2243 | 2346 | tp @ 2346 | 1.53 | -0.74 | 1.87 | 过 |
| `ethusdt-15m-20260820T0815-mirror` | short | bar 0 | 2283.71 | 2321 | 2231 | tp @ 2231 | 1.41 | -0.81 | 1.46 | 过 |
| `ethusdt-15m-20260820T0815-stale` | long | bar 0 | 2283.71 | 2235 | 2333 | tp @ 2333 | 1.01 | -0.62 | 1.12 | 拒:证据新鲜度 |

## 逐 case

| case | 模式 | 动作 | 方向 | 信心 | 来源 | 闸 | 节点 | 边 | 检查 |
|---|---|---|---|---|---|---|---|---|---|
| `btcusdt-15m-20260807T1500` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260807T1500-halted` | scan | NO_TRADE | - | 1.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260807T1500-mirror` | scan | NO_TRADE | short | 0.00 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260807T1500-mirror-rev1` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260807T1500-mirror-rev2` | review | HOLD | long | 0.30 | first | 过 | review:in_position | position.HOLD | ok |
| `btcusdt-15m-20260807T1500-mirror-rev3` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260807T1500-rev1` | review | EXIT | short | 0.60 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260807T1500-rev2` | review | EXIT | short | 0.55 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260807T1500-rev3` | review | HOLD | short | 0.35 | first | 过 | review:in_position | position.HOLD | ok |
| `btcusdt-15m-20260807T1500-stale` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260810T0700` | scan | WATCH | long | 0.55 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260810T0700-halted` | scan | NO_TRADE | - | 0.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260810T0700-mirror` | scan | WATCH | short | 0.40 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260810T0700-mirror-rev1` | review | EXIT | - | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260810T0700-mirror-rev2` | review | EXIT | long | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260810T0700-rev1` | review | EXIT | short | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260810T0700-rev2` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260810T0700-stale` | scan | WATCH | long | 0.45 | first | 过 | scan | scan.WATCH | ok |
| `btcusdt-15m-20260811T1430` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260811T1430-halted` | scan | NO_TRADE | - | 1.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260811T1430-mirror` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260811T1430-mirror-rev1` | review | EXIT | short | 0.85 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260811T1430-mirror-rev2` | review | EXIT | short | 0.95 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260811T1430-rev1` | review | EXIT | long | 0.72 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260811T1430-rev2` | review | EXIT | long | 0.95 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260811T1430-stale` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260812T0945` | scan | NO_TRADE | - | 0.70 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260812T0945-halted` | scan | NO_TRADE | - | 0.90 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260812T0945-mirror` | scan | NO_TRADE | - | 0.85 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260812T0945-mirror-rev1` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260812T0945-mirror-rev2` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260812T0945-mirror-rev3` | review | EXIT | short | 0.60 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260812T0945-rev1` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260812T0945-rev2` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260812T0945-rev3` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260812T0945-stale` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260813T1130` | scan | NO_TRADE | short | 0.60 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260813T1130-halted` | scan | NO_TRADE | - | 0.00 | repair | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260813T1130-mirror` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260813T1130-mirror-rev1` | review | EXIT | short | 0.72 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260813T1130-mirror-rev2` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260813T1130-rev1` | review | EXIT | long | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260813T1130-rev2` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `btcusdt-15m-20260813T1130-stale` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260830T1700` | scan | PROPOSE | long | 0.55 | first | 过 | scan | scan.PROPOSE | ok |
| `btcusdt-15m-20260830T1700-halted` | scan | NO_TRADE | - | 0.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260830T1700-mirror` | scan | PROPOSE | short | 0.60 | first | 过 | scan | scan.PROPOSE | ok |
| `btcusdt-15m-20260830T1700-mirror-rev1` | review | HOLD | short | 0.60 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260830T1700-mirror-rev2` | review | HOLD | short | 0.60 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260830T1700-rev1` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260830T1700-rev2` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | rubric✗ |
| `btcusdt-15m-20260830T1700-stale` | scan | PROPOSE | long | 0.60 | first | 拒 | scan | scan.PROPOSE | 过期开仓 rubric✗ |
| `btcusdt-15m-20260830T2000` | scan | NO_TRADE | - | 0.70 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260830T2000-halted` | scan | NO_TRADE | - | 0.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `btcusdt-15m-20260830T2000-mirror` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `btcusdt-15m-20260830T2000-mirror-rev1` | review | INVALIDATE | - | 0.85 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `btcusdt-15m-20260830T2000-mirror-rev2` | review | INVALIDATE | - | 0.85 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `btcusdt-15m-20260830T2000-mirror-rev3` | review | INVALIDATE | long | 0.80 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `btcusdt-15m-20260830T2000-rev1` | review | INVALIDATE | short | 0.85 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `btcusdt-15m-20260830T2000-rev2` | review | INVALIDATE | short | 0.80 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `btcusdt-15m-20260830T2000-rev3` | review | INVALIDATE | short | 0.85 | first | 过 | review:pending_entry | pending.INVALIDATE | ok |
| `btcusdt-15m-20260830T2000-stale` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260808T1830` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260808T1830-halted` | scan | NO_TRADE | - | 1.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260808T1830-mirror` | scan | NO_TRADE | - | 0.85 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260808T1830-mirror-rev1` | review | HOLD | long | 0.35 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260808T1830-mirror-rev2` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260808T1830-rev1` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260808T1830-rev2` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260808T1830-stale` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260811T1215` | scan | NO_TRADE | short | 0.30 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260811T1215-halted` | scan | NO_TRADE | - | 0.90 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260811T1215-mirror` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260811T1215-mirror-rev1` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260811T1215-mirror-rev2` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260811T1215-mirror-rev3` | review | EXIT | short | 1.00 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260811T1215-rev1` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260811T1215-rev2` | review | EXIT | - | 0.75 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260811T1215-rev3` | review | EXIT | long | 0.95 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260811T1215-stale` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260812T0930` | scan | NO_TRADE | - | 0.85 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260812T0930-halted` | scan | NO_TRADE | - | 1.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260812T0930-mirror` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260812T0930-mirror-rev1` | review | EXIT | short | 0.60 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260812T0930-mirror-rev2` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260812T0930-rev1` | review | EXIT | long | 0.60 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260812T0930-rev2` | review | EXIT | long | 0.75 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260812T0930-stale` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260813T1015` | scan | WATCH | short | 0.55 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260813T1015-halted` | scan | NO_TRADE | - | 0.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260813T1015-mirror` | scan | WATCH | long | 0.55 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260813T1015-mirror-rev1` | review | HOLD | long | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260813T1015-mirror-rev2` | review | HOLD | long | 0.70 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260813T1015-rev1` | review | HOLD | short | 0.55 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260813T1015-rev2` | review | HOLD | short | 0.72 | first | 过 | review:in_position | position.HOLD | ok |
| `ethusdt-15m-20260813T1015-stale` | scan | WATCH | short | 0.50 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260819T1345` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260819T1345-halted` | scan | NO_TRADE | - | 0.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260819T1345-mirror` | scan | NO_TRADE | - | 0.90 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260819T1345-mirror-rev1` | review | EXIT | - | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260819T1345-mirror-rev2` | review | EXIT | long | 1.00 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260819T1345-mirror-rev3` | review | EXIT | long | 1.00 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260819T1345-rev1` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260819T1345-rev2` | review | EXIT | short | 1.00 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260819T1345-rev3` | review | EXIT | short | 1.00 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260819T1345-stale` | scan | NO_TRADE | - | 0.80 | first | 过 | scan | scan.NO_TRADE | ok |
| `ethusdt-15m-20260820T0815` | scan | PROPOSE | long | 0.55 | first | 过 | scan | scan.PROPOSE | ok |
| `ethusdt-15m-20260820T0815-halted` | scan | NO_TRADE | - | 0.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260820T0815-mirror` | scan | PROPOSE | short | 0.55 | first | 过 | scan | scan.PROPOSE | ok |
| `ethusdt-15m-20260820T0815-mirror-rev1` | review | EXIT | long | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260820T0815-mirror-rev2` | review | EXIT | long | 0.85 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260820T0815-rev1` | review | EXIT | short | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260820T0815-rev2` | review | EXIT | short | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260820T0815-stale` | scan | PROPOSE | long | 0.62 | first | 拒 | scan | scan.PROPOSE | 过期开仓 rubric✗ |
| `ethusdt-15m-20260822T1245` | scan | WATCH | long | 0.55 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260822T1245-halted` | scan | NO_TRADE | - | 1.00 | first | 过 | scan:halted | halted.NO_TRADE | ok |
| `ethusdt-15m-20260822T1245-mirror` | scan | WATCH | short | 0.55 | first | 过 | scan | scan.WATCH | ok |
| `ethusdt-15m-20260822T1245-mirror-rev1` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260822T1245-mirror-rev2` | review | EXIT | long | 0.72 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260822T1245-mirror-rev3` | review | EXIT | long | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260822T1245-rev1` | review | EXIT | short | 0.80 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260822T1245-rev2` | review | EXIT | short | 0.65 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260822T1245-rev3` | review | EXIT | short | 0.70 | first | 过 | review:in_position | position.EXIT | ok |
| `ethusdt-15m-20260822T1245-stale` | scan | WATCH | long | 0.55 | first | 过 | scan | scan.WATCH | ok |

## 判断图

- graph 字段: 124 个来自 run 记录, 0 个为报告回填
- 走到的模型边: scan.NO_TRADE, scan.WATCH, scan.PROPOSE, halted.NO_TRADE, pending.INVALIDATE, position.HOLD, position.EXIT
- **没覆盖到的模型边**: pending.HOLD, position.REDUCE, position.INVALIDATE
- 走到的事件边: none.kline_close, pending_entry.thread_review, in_position.order_filled, in_position.position_review
- 没覆盖到的事件边(45): none.scan, none.manual, none.chat, none.heartbeat, none.breakout, none.ema_cross, none.vol_spike, none.retest, none.fast_move, none.session, none.funding, none.schedule, pending_entry.kline_close, pending_entry.manual, pending_entry.chat, pending_entry.heartbeat, pending_entry.info_update, pending_entry.order_filled, pending_entry.tp_hit, pending_entry.sl_hit, pending_entry.position_review, pending_entry.fast_move, pending_entry.breakout, pending_entry.ema_cross, pending_entry.vol_spike, pending_entry.retest, pending_entry.session, pending_entry.funding, pending_entry.monitor, in_position.kline_close, in_position.manual, in_position.chat, in_position.heartbeat, in_position.info_update, in_position.tp_hit, in_position.sl_hit, in_position.thread_review, in_position.fast_move, in_position.breakout, in_position.ema_cross, in_position.vol_spike, in_position.retest, in_position.session, in_position.funding, in_position.monitor

| 闸(guard id) | 拒绝次数 |
|---|---|
| fresh_evidence | 2 |

一次都没拒过的闸: halt, paused, no_position, daily_open_cap, stop_side, stop_distance, tp_side, confidence_floor, thread_limits, no_unknown_orders, preflight, no_add, thread_still_open

illegal_edge_attempts 0;path_replay_ok 100.0%

## trigger_precision

as_of 命中 66.7% (24/36);vol_spike 75.0% (12/16), breakout 83.3% (10/12), retest 33.3% (2/6), ema_cross 0.0% (0/2)(n=36)

在 28 个有独立行情的 scan case(base + mirror;stale/halted 与 base 同一份 K 线,不重复计)上重放 demo.detectTriggers。有效 = hidden horizon 内同向最大位移 ≥ 1 ATR。补充口径「盘内重放」= 在每根 visible K 线上重放规则,用其后 ≤ horizon 根 visible K 线打分(不用 hidden,不是同一件事,只作参考)。fast_move 需要 mark 价格环形缓冲(case 里没有)故永不触发;funding/session 无方向不计入 precision(盘内未计分: session 2)

**as_of(主口径,对 hidden 未来打分)** — 66.7% (24/36)

| 触发种类 | 样本 | 有效(≥1 ATR 同向) | precision | 同向最大位移均值(ATR) |
|---|---|---|---|---|
| vol_spike | 16 | 12 | 75.0% | 4.69 |
| breakout | 12 | 10 | 83.3% | 5.08 |
| retest | 6 | 2 | 33.3% | 0.77 |
| ema_cross | 2 | 0 | 0.0% | 0.76 |

**盘内重放(补充口径,对其后的 visible K 线打分)** — 75.9% (176/232)

| 触发种类 | 样本 | 有效(≥1 ATR 同向) | precision | 同向最大位移均值(ATR) |
|---|---|---|---|---|
| vol_spike | 86 | 62 | 72.1% | 3.14 |
| breakout | 78 | 60 | 76.9% | 3.05 |
| retest | 36 | 30 | 83.3% | 7.22 |
| ema_cross | 32 | 24 | 75.0% | 4.49 |


## regime_agreement

**6.7% (1/15);range 0/0, volatile 0/0, bear 1/8, bull 0/7**(n=15,状态 INFO) — judgment 的方向 vs demo.dailyRegime 的偏向(bull=long / bear=short;range 与 volatile 无方向不计分)。方向取 judgment.direction;复查里 HOLD/ADD/REDUCE 没有 direction 时按线程方向算(它就是被保留的立场),EXIT/INVALIDATE 不表达方向故不计分。未计分:无 1d K 线 0、regime 无方向 98、判断无方向 11

| 日线 regime | case | 计分 | 与判断方向一致 |
|---|---|---|---|
| range | 62 | 0 | 0 |
| volatile | 36 | 0 | 0 |
| bear | 16 | 8 | 1 |
| bull | 10 | 7 | 0 |

## 复查反事实 R(单路径,不是 P&L)

**平均 regret 0.43R(中位 0.00),选中最优 54.4%;HOLD 到底均值 -0.91R vs 此刻离场 -0.96R**(n=68)

> 口径:用 hidden K 线把每个复查 case 结算两次 —— `hold_r` = 什么都不做,持到止损/止盈,都没碰到就按 horizon 末根收盘 mark-to-market;`exit_now_r` = 按 as_of 收盘价平掉;挂单则是 `keep_r`(留着,horizon 内没成交 = 0)对 `invalidate_r` = 0。R 的分母始终是开仓时的 |成交价 − 止损|。**单路径**:不再入场、不分批、无手续费与滑点,REDUCE 按「半 hold 半 exit」线性近似。所以它是方向性证据(这批判断整体偏早/偏晚了多少 R),不是策略盈亏。

| 判断动作 | n | 平均 chosen R | 平均 best R | 平均 regret R | 选中最优 |
|---|---|---|---|---|---|
| EXIT | 51 | -1.25 | -0.80 | 0.45 | 30/51 |
| HOLD | 11 | -0.70 | -0.12 | 0.58 | 1/11 |
| INVALIDATE | 6 | 0.00 | 0.00 | 0.00 | 6/6 |

2×2(判 HOLD/EXIT × 事后哪边更好;REDUCE 不进这张表):

| | 事后 HOLD 更好 | 事后 EXIT 更好 |
|---|---|---|
| 判 HOLD | 1 | 10 |
| 判 EXIT/INVALIDATE | 33 | 24 |
| 判 REDUCE(表外) | 0 | |

- 判 EXIT 的 case 上,改成 HOLD 平均 **0.17R**(正 = 早走亏了)
- 判 HOLD 的 case 上,改成此刻离场平均 **0.54R**(正 = 多扛亏了)
- HOLD 走到哪:expired 14, stop 32, tp 16, unfilled 6

| regret 最大的 case | 判断 | chosen R | 最优 | best R | regret R |
|---|---|---|---|---|---|
| `btcusdt-15m-20260810T0700-mirror-rev2` | EXIT | 0.1805 | HOLD | 2 | 1.8195 |
| `btcusdt-15m-20260810T0700-rev2` | EXIT | 0.1805 | HOLD | 2 | 1.8195 |
| `btcusdt-15m-20260810T0700-mirror-rev1` | EXIT | 0.3094 | HOLD | 2 | 1.6906 |
| `btcusdt-15m-20260810T0700-rev1` | EXIT | 0.3094 | HOLD | 2 | 1.6906 |
| `btcusdt-15m-20260812T0945-mirror-rev1` | EXIT | 0.4809 | HOLD | 2 | 1.519 |
| `btcusdt-15m-20260812T0945-rev1` | EXIT | 0.4809 | HOLD | 2 | 1.519 |
| `btcusdt-15m-20260813T1130-mirror-rev1` | EXIT | 0.5423 | HOLD | 2 | 1.4577 |
| `btcusdt-15m-20260813T1130-rev1` | EXIT | 0.5423 | HOLD | 2 | 1.4577 |
| `btcusdt-15m-20260813T1130-mirror-rev2` | EXIT | 0.6644 | HOLD | 2 | 1.3355 |
| `btcusdt-15m-20260813T1130-rev2` | EXIT | 0.6644 | HOLD | 2 | 1.3355 |


## vs_mechanical(agent 相对机械基线)

**机械基线 -0.11R(n=56);agent PROPOSE 6 例:agent +0.16R vs 机械 -1.00R(配对 n=6,edge +1.16R);agent 跳过的 50 例机械 +0.00R(选择性 -0.11R)**(n=56)

| 分组 | n | 平均 R | 中位 R | 胜率 | 合计 R |
|---|---|---|---|---|---|
| 机械-always(所有可结算 scan) | 56 | -0.11R | -1.00R | 35.7% | -6.00R |
| 全部 PROPOSE 上的机械单 | 6 | -1.00R | -1.00R | 0.0% | -6.00R |
| PROPOSE 配对(共 6 个提案) | 6 | agent +0.16R vs 机械 -1.00R | 机械 -1.00R | 机械 0.0% | 机械 -6.00R |
| agent 跳过(NO_TRADE·WATCH) | 50 | +0.00R | -1.00R | 40.0% | +0.00R |
| 其他动作 | 0 | n/a | n/a | n/a | +0.00R |
| 采样不稳定(不归入动作组) | 0 | n/a | n/a | n/a | +0.00R |

> 怎么读:第一行是那枚硬币在这批 scan case 上的成绩(56/56 个 scan case 可结算,包含采样不稳定 case);PROPOSE/跳过/其他动作组只计稳定判断,不稳定组单列;配对行左边是 agent 自己那笔提案单的 R、右边是**同一批 case** 上硬币的 R,edge +1.16R 为正 = agent 提案优于这些点上的机械单;跳过行是被 agent 放掉的 case 上硬币本来会拿到的 R,选择性 = 机械-always 平均 − 跳过平均 = **-0.11R**,为正 = 跳掉的那批确实比平均更差(跳对了)。单路径、无手续费滑点,方向性证据不是 P&L;本项只报告,不参与晋升判定。

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
    "review": 68,
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
  "rubric_cases": 48,
  "rubric_agreement": 0.875
}
```
