# 字段速查:BacktestReport 与诊断 findings

契约:`packages/contracts/schema/research-backtest.json`、`research-orders.json`。所有收益是小数(0.16 = 16%)。

## 报告顶层

- `strategy_ir`:编译后的规则。`signal[]` 入场;`exit[]` 离场原语;`risk.stop` 初始止损;`risk.sizing` 仓位;
  `regime` 方向门;`order`(有它就走订单周期执行核):`direction`、`market`(spot/perp)、`leverage`、
  `entry.type`(market/limit)与 `entry.price`、`take_profits[]`、`min_rr`。
- `execution.sizing_mode`:仓位口径文字。含 `unit_notional` / 「100% 可用」= 满仓口径;含 `risk_fraction` = 按风险下单。
- `warnings[]`:报告级提示。「期末仍有持仓,按最后收盘价盯市计入净值」「只有 N 笔平仓,低于 30 笔纪律线」都在这里。
- `segments`:样本内 / 样本外(70/30)分界。`primary_key`:主资产。`inquiry_id`:提出这次回测的研究问题。

## 每个资产 `assets[]`

- `kind`:single 单资产 / basket(BTC+ETH 两腿各 50%)。篮子的逐笔收益是按腿算的,不能连乘核数。
- `metrics`:`total_return` 总收益、`benchmark_return` 同窗口持有、`excess_return`、`max_drawdown`、`sharpe`、
  `trades` 平仓数、`win_rate`、`exposure`(持仓市值/净值的逐根均值)、`time_in_market`(有持仓的 bar 占比)、`fees`、`net_pnl`。
- `segments[].metrics`:样本内、样本外各自的同一套指标(含各段持有)。
- `trades[]`:逐笔,`return_pct` 是这笔相对入场名义的净收益,`exit_reason` 是离场原因。
- `trade_stats.pnl_by_exit_reason`:按离场原因汇总 {count, pnl, avg_return}。
- `capital_usage`:`avg_exposure`、`time_in_market`、`idle_fraction`。
- `plans[]`(仅订单周期执行核):`status`(filled/no_fill/replaced/cancelled/blocked/pending)、`blocked_reason`
  (min_rr / no_stop / stop_side / target_side / gap_invalidated / opposite_signal)、`entry_type`、`entry_price`(限价)、
  `reference_price`(信号收盘价)、`stop.note`(含 `cost_floor` = 被放宽到成本下限)。
- `plan_stats`:`placed`、`filled`、`no_fill`、`blocked`、`fill_rate`、`tp_hit_rate`、`sl_hit_rate`、`rolled`、`liquidated`。

## 离场原因中英对照

stop/sl 止损 · trail 追踪止损 · target/tp 止盈 · indicator_cross_exit/signal_exit 信号离场 · time 到期 ·
rolled 结转 · liquidation 强平 · breakeven 保本 · end_of_data 期末。

## 诊断 findings(`diagnose_backtest`,method_version diagnose/v2)

每条 {key, severity(high/medium/info), text},text 里带数值。按严重度排序。

- 核数与口径:`reconcile`(总收益 vs 逐笔连乘,期末持仓)、`sizing`(持仓期间平均仓位)。
- 忠实度:`faithful_trail` / `faithful_target` / `faithful_stop`(用户没提、IR 却有的离场,及它打出的笔数)、
  `limit_wrong_side`(限价挂在信号价不利一侧的比例)、`param_mismatch`(入场与离场均线参数不一致)。
- 比较对象:`exposure`(在场时间、持有、同敞口持有粗算)、`decay`(样本内外及各段持有)。
- 来源:`exit_mix`、`stop_tight`、`worst_exit`、`concentration`、`fees`、`assets`、`blocked`(被拦原因分布)、
  `stop_widened`(止损被成本下限放宽的比例)、`fill`(限价成交率)。
- 噪声:`sample`(平仓 < 30)、`variants`(同一策略已回测的变体数)。
