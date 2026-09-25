# 指标覆盖对照表(2026-09-22)

目标:常规交易者张口就来的指标与形态,研究引擎里都得有;并且不靠"每个组合写一个原语"来支撑,
而是靠**一张指标表 + 三个通用原语**(穿越 / 阈值 / 背离)把组合爆炸摊平。

- 指标表:`packages/gateway/src/demo/research/primitives/indicators.ts`(42 个指标,表驱动,本身不注册原语)
- 通用原语:`primitives/generic.ts`(`indicator_cross` / `indicator_threshold` / `indicator_divergence` 各配一个 `*_exit`)
- 形态原语:`primitives/patterns.ts`(8 个)
- 参数 schema:`packages/contracts/schema/research.json` 的 `PrimitiveParams*`;类型由 `npm run generate` 生成,不手改

## 口径约定

| 项 | 我们的口径 | 与谁一致 |
| --- | --- | --- |
| EMA 播种 | 前 n 根 SMA 作种子,之前为 NaN | TA-Lib `EMA`、pandas-ta `ema(sma=True)`(默认) |
| Wilder 平滑 | `smma`/`rma`,alpha=1/n,SMA 播种 | TA-Lib 内部、TradingView `ta.rma` |
| 标准差 | 总体口径 ddof=0 | TA-Lib `STDDEV`、TradingView `ta.stdev` |
| ATR | `atr[n] = mean(TR[1..n])` 后 Wilder 递推,首个有效下标 = n | TA-Lib `ATR`,也与本仓库既有 `registry.atr()` 一致 |
| 预热 | `warmup` = 拿到第一个非 NaN 值所需的最少 bar 数,测试逐个校验"多一根有值、少一根没值" | — |
| 因果 | `compute` 只读 `bars[0..i]`,全部指标在同一根上的值与全量数据一致 | — |

> 已知差异:旧原语 `ema_cross` / `macd_cross` / `macd_divergence` 里的 EMA 从第一根递推(无 NaN 段),
> 指标表里的 `ema`/`macd` 用 SMA 播种。两者在预热之后数值趋同但不完全相等;旧原语保留原实现以免既有回测结果漂移。

## 指标表(42 个)

| 我们的名字 | 中文 | 输出线 | 参数(默认) | pandas-ta | TA-Lib | TradingView |
| --- | --- | --- | --- | --- | --- | --- |
| `price` | 原始价格 | close/open/high/low/hl2/hlc3/ohlc4 | — | — | — | 内置 source |
| `sma` | 简单移动平均 | value | period=20 | `sma` | `SMA` | `ta.sma` |
| `ema` | 指数移动平均 | value | period=20 | `ema` | `EMA` | `ta.ema` |
| `wma` | 加权移动平均 | value | period=20 | `wma` | `WMA` | `ta.wma` |
| `dema` | 双指数移动平均 | value | period=20 | `dema` | `DEMA` | `ta.dema` |
| `tema` | 三重指数移动平均 | value | period=20 | `tema` | `TEMA` | `ta.tema` |
| `hma` | Hull 均线 | value | period=20 | `hma` | — | `ta.hma` |
| `vwma` | 量加权均线 | value | period=20 | `vwma` | — | `ta.vwma` |
| `smma` | Wilder 平滑均线(RMA) | value | period=20 | `rma` | — | `ta.rma` |
| `kama` | 考夫曼自适应均线 | value | period=10,fast=2,slow=30 | `kama` | `KAMA` | 社区脚本 |
| `macd` | MACD | macd/signal/hist | fast=12,slow=26,signal=9 | `macd` | `MACD` | `ta.macd` |
| `adx` | 平均趋向指数 | adx/plus_di/minus_di | period=14 | `adx` | `ADX`+`PLUS_DI`/`MINUS_DI` | `ta.dmi` |
| `supertrend` | 超级趋势 | supertrend/direction | period=10,multiple=3 | `supertrend` | — | `ta.supertrend` |
| `psar` | 抛物线 SAR | psar/direction | step=0.02,max_step=0.2 | `psar` | `SAR` | `ta.sar` |
| `ichimoku` | 一目均衡表 | conversion/base/span_a/span_b/lagging/lagging_ref | 9/26/52 | `ichimoku` | — | `ta.ichimoku`(内置指标) |
| `aroon` | 阿隆 | oscillator/up/down | period=14 | `aroon` | `AROON`/`AROONOSC` | 内置 |
| `vortex` | 涡旋 | plus/minus | period=14 | `vortex` | — | 内置 |
| `chop` | 震荡指数 | value | period=14 | `chop` | — | 内置 |
| `rsi` | 相对强弱 | value | period=14 | `rsi` | `RSI` | `ta.rsi` |
| `stoch` | 随机指标 KDJ | k/d/j | 14/3/3 | `stoch` | `STOCH` | `ta.stoch` |
| `stochrsi` | 随机 RSI | k/d | 14/14/3 | `stochrsi` | `STOCHRSI` | 内置 |
| `cci` | 顺势指标 | value | period=20 | `cci` | `CCI` | `ta.cci` |
| `mfi` | 资金流量 | value | period=14 | `mfi` | `MFI` | `ta.mfi` |
| `roc` | 变动率 | value | period=12 | `roc` | `ROC` | `ta.roc` |
| `willr` | 威廉 %R | value | period=14 | `willr` | `WILLR` | `ta.wpr` |
| `momentum` | 动量 | value | period=10 | `mom` | `MOM` | `ta.mom` |
| `trix` | TRIX | trix/signal | period=15,signal=9 | `trix` | `TRIX` | 内置 |
| `uo` | 终极摆动 | value | 7/14/28 | `uo` | `ULTOSC` | 内置 |
| `ao` | 动量震荡(AO) | value | fast=5,slow=34 | `ao` | — | 内置 |
| `elder_ray` | 艾达透视(多空力量) | bull/bear | period=13 | `eri` | — | 内置 Elder-Ray |
| `bbands` | 布林带 | middle/upper/lower/bandwidth/percent_b | period=20,multiple=2 | `bbands` | `BBANDS` | `ta.bb` |
| `keltner` | 肯特纳通道 | middle/upper/lower | 20/10/2 | `kc` | — | `ta.kc` |
| `donchian` | 唐奇安通道 | middle/upper/lower | period=20 | `donchian` | — | 内置 |
| `atr` | 平均真实波幅 | value | period=14 | `atr` | `ATR` | `ta.atr` |
| `natr` | 归一化 ATR | value | period=14 | `natr` | `NATR` | — |
| `stdev` | 标准差 | value | period=20 | `stdev` | `STDDEV` | `ta.stdev` |
| `obv` | 能量潮 | value | — | `obv` | `OBV` | `ta.obv` |
| `vwap` | VWAP(按 UTC 日重置) | value | — | `vwap` | — | `ta.vwap` |
| `cmf` | 蔡金资金流 | value | period=20 | `cmf` | — | 内置 |
| `ad` | 累积/派发线 | value | — | `ad` | `AD` | `ta.accdist` |
| `volume_ratio` | 量比 | value | period=20 | `rvol` 近似 | — | 社区脚本 |
| `chaikin` | 蔡金振荡器 | value | fast=3,slow=10 | `adosc` | `ADOSC` | 内置 |

多输出指标用 `output` 选线;单输出省略 `output` 即可。中英文别名(如 `布林`→`bbands`、`kdj`→`stoch`、
`一目`→`ichimoku`、`rma`→`smma`)见 `INDICATOR_ALIASES`,仅供人工/文档查询,**IR 里只接受规范名**。

## 通用原语:组合不爆炸

| 原语 | 类别 | 能表达什么 |
| --- | --- | --- |
| `indicator_cross` | signal | 任意指标线穿越:指标 vs 指标(SMA50 金叉 SMA200)、指标 vs 价格、指标 vs 常数(MACD 柱上穿 0 轴)。价格做主线用 `indicator:'price'` |
| `indicator_cross_exit` | exit | 同上,持仓时反向穿越即离场(死叉、跌破均线) |
| `indicator_threshold` | signal | 状态(`above`/`below`,如 RSI<30)或单根事件(`cross_above`/`cross_below`,如 RSI 上穿 30) |
| `indicator_threshold_exit` | exit | 同上,持仓时成立即离场(如 RSI 跌破 50) |
| `indicator_divergence` | signal | 任意指标的底背离(价格创更低的**已确认** pivot low 而指标抬高),确认当根触发一次 |
| `indicator_divergence_exit` | exit | 顶背离离场 |

保留的手写原语 `macd_cross` / `macd_divergence` / `macd_divergence_exit` 未删(已有测试与现网回测结果依赖),
语义等价于 `indicator_cross`/`indicator_divergence` 的 `indicator:'macd'` 版本,只是 EMA 播种口径不同。

## 形态原语(8 个)

| 原语 | 类别 | 触发定义(全部只用已确认 pivot / 已收盘 bar) |
| --- | --- | --- |
| `double_bottom` | signal | 两个容差内齐平的已确认 pivot low + 中间 pivot high 作颈线,**收盘首次突破颈线**当根 |
| `head_and_shoulders_inverse` | signal | 左肩/更低的头/右肩三个已确认 pivot low,两肩齐平,颈线取两个中间高点的较高者,收盘突破当根 |
| `bullish_engulfing` | signal | 前一根阴线实体被当根阳线实体完全吞没,且实体倍数达标 |
| `pin_bar` | signal | 锤子线:下影 ≥ 实体 × `tail_ratio`,实体与上影占振幅比例受限 |
| `fair_value_gap` | signal | 看涨三根缺口:第 i-2 根高点 < 第 i 根低点,中间为阳线,缺口宽度达标 |
| `inside_bar_breakout` | signal | 母线后连续内包线,收盘首次越过母线高点当根 |
| `double_top_exit` | exit | 双顶镜像,收盘首次跌破颈线当根离场 |
| `bearish_engulfing_exit` | exit | 看跌吞没,持仓时离场 |

反转形态一律以"颈线突破"为触发点而非 pivot 确认点:pivot 确认只是形态成形,颈线突破才是可交易的时刻,
而且它天然是单根事件(`prev <= neck && close > neck`),不会连续多根重复触发。

## 缺了什么、为什么

| 常见名 | 出处 | 状态 | 原因 |
| --- | --- | --- | --- |
| Zig Zag | TradingView 内置 | **不做** | 定义上会重绘(最后一段随新高新低回撤),等价于前视。因果替代是 `structure.ts` 的已确认 pivot |
| Volume Profile / POC / VAH-VAL | TradingView 内置 | **不做** | 需要分笔或更细粒度成交分布,当前数据层只有 K 线,伪造出来的近似会误导 |
| Renko / Heikin-Ashi / Kagi | TradingView | **不做** | 改的是 bar 的定义,属于数据层变换而不是指标层;要做应该在 dataset 上做,不是塞进指标表 |
| Anchored VWAP / VWAP 标准差带 | TradingView | 未做 | 需要用户指定锚点(事件、日期),参数模型不是一个数字;`vwap` 已按 UTC 日重置 |
| 枢轴点 Pivot Points(经典/斐波那契)、斐波那契回撤 | TradingView 内置 | 未做 | 需要"周期锚 + 画线"语义,和 pivot 高低点不是一回事;规划器目前把它列进 unmapped 如实告知 |
| TA-Lib 的 61 个 `CDL*` 蜡烛形态 | TA-Lib | 部分 | 只做了吞没 / 锤子 / 内包突破 / FVG 四类最常被口头提起的;其余长尾形态证据薄弱,按需一条一条加 |
| ALMA / T3 / TRIMA / ZLEMA / VIDYA / FRAMA / MAMA | TA-Lib、TradingView | 未做 | 均线族已覆盖 9 种主流(SMA/EMA/WMA/DEMA/TEMA/HMA/VWMA/KAMA/SMMA),其余加一行表即可,没人张口就来 |
| PPO / APO / PVO / CMO / ADXR / DX | TA-Lib | 未做 | 与已有指标同族(MACD/ADX 的变体),表里加一行的成本;暂无需求 |
| KST / Coppock / DPO / TSI / Fisher / Connors RSI / RVI / Force Index / EMV / Klinger / PVT / NVI-PVI / Mass Index / Ulcer / Squeeze | pandas-ta | 未做 | 长尾。指标表是表驱动的,每个只需 `{name, args, warmup, compute}` 一行 + 一条数值测试 |
| Hilbert Transform 系列 `HT_*` | TA-Lib | 未做 | 实现复杂、使用率极低 |
| 线性回归族 `LINEARREG` / `TSF` / `STDDEV bands` | TA-Lib | 未做 | 需要回归系数输出,和当前"一条线"的输出模型不冲突,但没人要 |
| Ichimoku 的可配 displacement | TradingView | 简化 | 固定 `displacement = period_2`(26,标准用法);先行 A/B 取 displacement 根之前算出的云值,迟行线额外给 `lagging_ref` 做对照,两者都不含前视 |
| Stochastic Fast | TA-Lib `STOCHF` | 等价参数 | `stoch` 即慢速版;把 `period_2=1` 就是快速版 |
| 单根真实波幅 `TRANGE` | TA-Lib | 等价参数 | `atr` 取 `period=1` |

## 怎么加一个新指标

1. 在 `INDICATORS` 里加一行:`{name, cn, aliases, category, args, outputs, warmup, compute}`;
   参数键只能从 `period / period_2 / period_3 / fast / slow / signal / multiple / step / max_step` 里选(schema 的 `args` 对象就是这九个)。
2. `warmup` 必须是**紧的**:`indicators.test.ts` 会验证"恰好 warmup 根有值、少一根至少一条输出是 NaN"。
3. 在 `research.json` 的六个 `indicator` / `compare_indicator` 枚举里加上名字,跑 `npm run generate --workspace @trading-swarm/contracts`
   (`indicators.test.ts` 里有枚举与 `INDICATOR_NAMES` 的一致性断言,漏改会红)。
4. 加一条数值测试:线性行情上多数指标有闭式解(见 `indicators.test.ts` 的"闭式解"几节),这是最省事的校验方式。
