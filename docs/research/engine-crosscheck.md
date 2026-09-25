# 第三轮引擎交叉对账

当前状态：**导出与比较程序已实现，外部引擎数值对账未完成**。本沙箱禁止连接 127.0.0.1:7897 代理，`pip install smartmoneyconcepts backtesting empyrical` 返回 ProxyError / EPERM；不将“没有跑成”写成一致。

复现程序位于 `packages/gateway/scripts/research-crosscheck/`，运行命令见该目录 README。生产代码不引入 Python。导出的相同 fixture 包含 2400 根合成 1h OHLCV、donchian 参数、费用、gateway A 臂逐笔结果、TS pivots/BOS/blocks。Python 比较 backtesting.py 下一 open 成交的入场时间/价格/数量、退出 bar/价格与净盈亏，并输出所有差异。

## 对齐的执行约定

- 两边均现货多头、不加仓、下一根 open、0.1% 单边手续费；此 fixture 设滑点 0，数量为整数。next open 与上一 close 相同，因此 Python 在下单时算数量没有额外未来输入。
- 初始止损为信号 close 减 ATR 距离，止盈为信号 close 加 2R；这是旧 policy 的明确锚点。新 IR fixed R 则按实际成交价定目标，不把两种口径混用。
- OHLC 同根双触发与跳空可能存在引擎约定差异；比较脚本同时导出退出 bar 和价格，必须检查差异后归因，不能只比较总收益。
- Gateway intrabar protective 时间戳是 close_time，未知 bar 内具体成交时刻；backtesting.py 给 bar 时间。按同一 bar 索引比对，不能把时间戳标签差异误报成一小时延迟。

## 指标口径

Gateway daily_sharpe 用完整内部 UTC 日收盘的简单收益、零无风险利率、样本标准差 ddof=1、crypto 年化 sqrt(365)，至少 30 个日收益才估计。脚本用相同日频样本送入 empyrical 并显式 annualization=365（其常见股票默认 252 不适用这里）。最大回撤在同一逐 bar equity 时钟比较；日线回撤不能与逐 bar 回撤冒称等价。符号上 gateway 为正的回撤幅度，empyrical 通常为负，脚本统一符号。

## SMC 参考与定义差异

参考 [smart-money-concepts MIT 源码](https://github.com/joshyattridge/smart-money-concepts/blob/master/smartmoneyconcepts/smc.py) 和 [LuxAlgo SMC 公开说明](https://www.tradingview.com/script/CnB3fSph-Smart-Money-Concepts-SMC-LuxAlgo/)。没有复制 Pine 代码。

本轮只实现 pivot、BOS/CHoCH、order block；pivot 在右侧 L 根完成后才可见。Python 库完整历史输出包含同类 swing 清理和端点处理；TS 不用未来 swing 回写旧确认点。Python BOS 使用 swing 序列组合，而本轮用收盘/影线突破最近已确认水平；OB 按任务书取突破前最后一根反向 K 线，Python 的区间选择规则不同。这些定义差异必须单列，不能强求全历史数组逐元素相等而引入前视。

`compare.py` 会保存 `structure-python.json`（swing/BOS BrokenIndex/OB Top/Bottom）及逐点 pivot 差异；TS 输出同时保存确认时刻和色块形成时刻。由于安装被阻塞，本轮尚未生成真实 Python fixture，也未完成数值差异结论。未验证任何策略收益有效性。
