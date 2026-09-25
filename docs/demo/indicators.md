# 指标库(`packages/gateway/src/demo/indicators.ts`)

从 8794 控制台(`~/Desktop/trade-switch-rs`,`backend/crates/console-core/src/indicators.rs` 的 34 个 ta-lib 指标)移植过来的技术指标库,再补上 8794 没有、但判断/策略需要的那几个(VWAP、Supertrend、Keltner、Donchian、Squeeze、Ichimoku、成交量分布)。

在此之前,模型能看到的全部「技术面」只有四样:EMA20/50、ATR14、20 根高低、量比。这份库把它扩到 35 个指标族,并且走三条路出去:

1. **证据**:`tfFeatures()` 顺手算一份 `IndicatorSnapshot` 挂在 `TfFeatures.indicators` 上 → `scanChecklist()` 把 RSI / ADX / BB 宽分位 / 挤压 / 距 VWAP 写进「扫描清单(代码计算)」那一行证据;
2. **接口**:`GET /api/market/indicators`(§9.10 of `v3-ui-contract.md`);
3. **图表**:前端 `useIndicatorOverlays()` 叠加层。

---

## 三条铁律

- **升序 K 线进,等长序列出**。`out.length === input.length`,永远不会因为热身期就把数组截短——下标 `i` 在任何一条序列上都指同一根 K 线。
- **热身期是 NaN,不是 0**。0 是一个模型可以引用的真实数字,NaN 不是。`last(series)` 会跳过热身条目,拿不到就返回 `null`。
- **纯函数**。没有 I/O、没有 `Date.now()`、不改入参。所以任何一条判断都能用「当时可见的 K 线」重放出同样的数字——这正是 `context.ts` 系统规则 2b(模型引用的每个数字都必须有登记来源)成立的前提。

### 与 `market.ts` 的两处刻意分歧

| | `market.ts` | `indicators.ts` | 为什么 |
|---|---|---|---|
| `ema()` | 用第一个值播种,无热身期 | 用前 `period` 个值的 SMA 播种(ta-lib / 8794 口径) | 8794 对齐 TradingView;两者在 200 根以上收敛到 ~1e-11,`indicators.test.ts` 里有断言 |
| `atr()` | 返回**一个数**(最后 `period` 根 TR 的简单平均) | 返回**序列**(Wilder RMA 平滑) | 图表要序列;Wilder 才是 ATR 的定义。`TfFeatures.atr14` 仍是旧口径,`IndicatorSnapshot.atr14` 是新口径,两者都在证据里各自标注 |

`index.ts` 把两者分别导出为 `ema` / `emaSeries`、`atr` / `atrSeries`。

---

## 指标清单

`参数` 一列是默认值;`8794 对照` 说明与 Rust 实现的差异。所有输出都是等长序列,除非另外注明。

### 均线族

| 函数 | 参数 | 输出 | 说明 | 8794 对照 |
|---|---|---|---|---|
| `sma(values, period)` | period | `number[]` | 滚动均值;遇到 NaN 洞会重置窗口而不是把后面全污染 | ✅ `sma`,同 |
| `ema(values, period)` | period | `number[]` | α=2/(p+1),SMA 播种 | ✅ `ema`,同 |
| `wma(values, period)` | period | `number[]` | 权重 1..period,最新一根权重最大 | ✅ `wma`,同 |
| `dema(values, period)` | period | `number[]` | `2·EMA − EMA(EMA)` | ✅ `dema`,同 |
| `tema(values, period)` | period | `number[]` | `3·EMA1 − 3·EMA2 + EMA3` | ✅ `tema`,同 |
| `rma(values, period)` | period | `number[]` | Wilder / SMMA 平滑,α=1/period。**不等于 `ema(values, period)`**,等于 `ema(values, 2·period−1)` | ✅ 8794 内联在 rsi/atr/adx 里,这里提成公开函数 |
| `stdev(values, period)` | period=20 | `number[]` | **总体**标准差(÷N),Bollinger 的定义 | ✅ `stddev`,同(8794 也是总体) |

### 震荡指标

| 函数 | 参数 | 输出 | 说明 | 8794 对照 |
|---|---|---|---|---|
| `rsi(closes, period)` | 14 | `number[]` 0–100 | Wilder RMA;avg_loss=0 → 100,全平 → 50 | ✅ `rsi`,同 |
| `stochRsi(closes, period)` | 14 | `number[]` 0–100 | RSI 序列在自己 `period` 窗口内的 min-max 位置(ta-lib fastK of RSI) | ✅ `stochrsi`,同 |
| `stochastic(ks, k, d, smooth)` | 14 / 3 / 3 | `{fast_k, k, d}[]` | 慢速随机指标:fast %K → SMA(smooth)=慢 %K → SMA(d)=%D。窗口全平报 50 | ✅ `stoch_k`/`stoch_d`,同(8794 的 slowk/slowd 写死 3) |
| `macd(closes, fast, slow, signal)` | 12 / 26 / 9 | `{macd, signal, hist}[]` | EMA 差,signal 是 EMA;`hist = macd − signal` | ✅ `macd`/`macd_signal`/`macd_hist`,同 |
| `cci(ks, period)` | 20 | `number[]` | TP=(H+L+C)/3,**平均绝对偏差**(不是标准差),Lambert 0.015 | ✅ `cci`,同 |
| `williamsR(ks, period)` | 14 | `number[]` −100…0 | 窗口全平报 −50 | ✅ `willr`,同 |
| `mfi(ks, period)` | 14 | `number[]` 0–100 | 原始窗口内直接求和(不做 Wilder 平滑) | ✅ `mfi`,同(8794 也是简化版,注释里写明了) |
| `momentum(closes, period)` | 10 | `number[]` | `close[t] − close[t−period]` | ✅ `mom`,同 |
| `roc(closes, period)` | 10 | `number[]` % | `(close[t]/close[t−period] − 1)·100` | ✅ `roc`,同 |
| `trix(closes, period)` | 30 | `number[]` % | 三重 EMA 的 1 根变化率 | ✅ `trix`,同 |

### 波动率与通道

| 函数 | 参数 | 输出 | 说明 | 8794 对照 |
|---|---|---|---|---|
| `trueRange(ks)` | — | `number[]` | TR[0] = H−L(没有前收可比) | ✅ 内联 |
| `atr(ks, period)` | 14 | `number[]` | Wilder RMA of TR | ✅ `atr`,同 |
| `bollinger(closes, period, mult)` | 20 / 2 | `{mid, upper, lower, width_pct}[]` | `width_pct = (upper−lower)/mid×100`,分位排名和挤压都建立在它上面 | ✅ `bb_upper`/`bb_middle`/`bb_lower`;`width_pct` 是本仓库新增 |
| `keltner(ks, period, mult)` | 20 / 1.5 | `{mid, upper, lower}[]` | `EMA(close, p) ± mult × ATR(p)` | ❌ 8794 没有 |
| `squeeze(ks, bbP, bbK, kcP, kcK)` | 20/2/20/1.5 | `{on, bars_on}[]` | TTM 式:BB 完全落在 KC 里 = 波动被压缩。`bars_on` 是连续根数,热身期报 `{on:false, bars_on:0}` | ❌ 8794 没有(只在文档里作为一个用户自写 Rhai 脚本的例子出现) |
| `donchian(ks, period)` | 20 | `{upper, lower, mid}[]` | **含当前根**的最高高/最低低 | ❌ 8794 没有(`aroon` 是最接近的亲戚) |

### 趋势

| 函数 | 参数 | 输出 | 说明 | 8794 对照 |
|---|---|---|---|---|
| `adx(ks, period)` | 14 | `{adx, plus_di, minus_di}[]` | +DM/−DM/TR 三条都走 Wilder RMA,DX 再 Wilder 一次(双重平滑)。ADX ≥ 20 是快照里「到底有没有趋势」的那条线 | ✅ `adx`/`plus_di`/`minus_di`,同 |
| `supertrend(ks, period, mult)` | 10 / 3 | `{value, dir:1\|-1}[]` | `hl2 ± mult×ATR`,轨道只朝有利方向棘轮;收盘穿到对侧轨道就翻向 | ❌ 8794 没有(只在 handoff 文档里作为 TradingView 内置项被提到) |
| `psar(ks, step, max)` | 0.02 / 0.2 | `{value, dir}[]` | Wilder 抛物线转向,SAR 不得穿透前两根的极值 | ✅ `sar`,同(8794 同样写死 0.02/0.2) |
| `aroon(ks, period)` | 25 | `{up, down, osc}[]` | 极值出现得多近,占窗口的百分比 | ✅ `aroon_up`/`aroon_down`;`osc` 是本仓库新增 |
| `ichimoku(ks, c, b, spanB, disp)` | 9/26/52/26 | `{tenkan, kijun, senkou_a, senkou_b, cloud_top, cloud_bottom, chikou}[]` | `senkou_*` 是**在这根算出来的**值(实际画在 26 根之后);`cloud_*` 是**作用在这根**的云(26 根前算出来的),所以「价在云上/云中/云下」可以直接读 | ❌ 8794 没有 |

### 量能与结构

| 函数 | 参数 | 输出 | 说明 | 8794 对照 |
|---|---|---|---|---|
| `obv(ks)` | — | `number[]` | 从 0 起累计带符号成交量,**相对于传进来的窗口**,只有斜率有意义 | ✅ `obv`,同(8794 注释里也明确是窗口相对) |
| `chaikinAd(ks)` | — | `number[]` | `((C−L)−(H−C))/(H−L)·vol` 累计,同样窗口相对 | ✅ `ad`,同 |
| `vwap(ks, anchor)` | `'day'` | `number[]` | TP 加权。`'day'` 每个 UTC 零点重置;`'session'` 每 8 小时资金费率结算(00/08/16 UTC)重置;`'all'` 不重置。累计成交量为 0 时留 NaN,不把价格当成自己的 VWAP | ❌ 8794 没有(后端任何地方都没实现 VWAP) |
| `volumeProfile(ks, bins, lookback, vaPct)` | 24/120/0.7 | `{poc, vah, val, bins}` 或 `null` | 每根 K 线的成交量在它 H–L 覆盖的价格桶里**平均摊开**;价值区从 POC 向外吃更胖的邻居直到覆盖 70 % | ⚠️ 8794 有,但不是指标:是 agent 专用工具 `get_volume_profile`(`bin_count=40`,含 HVN/LVN),不进 `/api/market/indicators` |
| `swingPoints(ks, left, right)` | 3 / 3 | `{highs:[idx,price][], lows:[idx,price][]}` | 分形高低点:窗口内的**严格**最大/最小。最后 `right` 根还可能变,所以永不上报——这里的摆动点是已确认的,不是暂定的 | ⚠️ 8794 只有 Rhai 脚本用的 `pivothigh`/`pivotlow` 辅助函数,不是原生指标。8794 把值落在确认根(`pivot+right`)上,这里落在**枢轴根本身**(返回的是下标),不重画但下标含义不同 |
| `percentileRank(series, window)` | — | `number[]` 0–100 | 每个值在自己 `window` 内的分位。可比较值不足 5 个时 NaN。ATR% 与 BB 宽的分位都走它 | ❌ 8794 没有 |

### 汇总

| 函数 | 输出 | 说明 |
|---|---|---|
| `indicatorSnapshot(ks, tf)` | `IndicatorSnapshot \| null` | 上面全部的**最后值**,外加 `atr_pct`、`atr_pct_rank_90`、`bb_width_rank_90`、`dist_to_vwap_atr`、`obv_slope_10`、`price_vs_cloud`、`trend`、`trend_strength`。O(bars),回测里逐根调也扛得住 |
| `describeIndicators(snapshot)` | `string` | 一行紧凑中文,≤ 220 字,给证据用。只印**已就绪**的指标,热身期的 NaN 直接不出现——绝不渲染成 0,因为这一行里的每个数字模型都可以引用 |
| `trendStrengthOf(adx)` | `'none'\|'weak'\|'moderate'\|'strong'` | Wilder 自己的分档:< 20 无 / 20–25 弱 / 25–40 中 / ≥ 40 强 |
| `last(series)` | `T \| null` | 跳过热身条目取最后一个「就绪」值 |

**`trend` 的定义**:EMA20 vs EMA50 定方向,**ADX ≥ 20 才承认有趋势**,否则一律 `'flat'`。均线排好了但 ADX 只有 12 的震荡市,过去会被读成「趋势」,现在读成「无趋势」。

---

## 接进扫描清单

`review-metrics.ts` 的两处改动:

**1. ATR% 门槛按周期分档**(`ATR_PCT_FLOOR` 表 + `atrPctFloor(tf)`)。原来是一个 0.4 %——那是 4h 的门槛套在 5m 上,结果 5m 几乎永远「不足」,模型学会了无视这一格。波动率按时间平方根缩放,门槛也就跟着:`0.08 % × √(分钟/5)`,正好推出表里的 0.15 / 0.30 / 0.6。

| tf | 1m | 5m | 15m | 30m | 1h | 4h | 1d |
|---|---|---|---|---|---|---|---|
| 门槛 % | 0.04 | 0.08 | 0.15 | 0.2 | 0.3 | 0.6 | 1.5 |

表里没有的周期走 √ 缩放兜底;`tfToMs` 解析不了就退回 0.3。

**2. 清单多一行五格**:`RSI14`、`ADX14(趋势强弱)`、`BB宽 N 分位`、`挤压 是(N 根)/否`、`距VWAP ±N.NN ATR`。这五格合起来分得清「安静盘整、值得盯」和「已经拉开、没得追」。全文仍 ≤ 320 字。

数据来源有两条,先后顺序是:`features[0].indicators`(`tfFeatures()` 已经算好)→ 调用方直接传进来的 `klines`。**旧的单参数调用照常工作**,只是那五格会是 n/a:

```ts
scanChecklist(features);            // features[0].indicators 有就用,没有就 n/a
scanChecklist(features, klines);    // 显式给 K 线
```

`context.ts` 不用改——它传的 `features` 已经带着快照了。

---

## 没能移植的部分

| 8794 的东西 | 为什么没搬 |
|---|---|
| 自定义指标引擎(Pine runner + AI 翻译成 Rhai 脚本,`custom_indicators.rs` / `IndicatorsPage.tsx`) | 那是一整套用户自写指标的子系统(沙箱化的脚本运行时、Pine→Rhai 的模型翻译、每用户存储),不是指标库本身。trading-swarm 这边没有对应的用户产物概念 |
| `indicator_series_generic` 的 O(n²) 前缀重算 | 8794 除 sma/ema/rsi 外的每条历史序列都是在每个递增前缀上重算一次 `indicator_value`。这里每个指标本来就是一次 O(n) 扫出整条序列,不需要这条退化路径 |
| `GET /api/market/indicator-series?name=` (单条序列端点) | `/api/market/indicators?set=<单个名字>` 已经覆盖,不再单开一个路由 |
| Rhai 辅助函数库(`crossover` / `valuewhen` / `barssince` / `ffill` …) | 只有自定义脚本引擎需要它们 |
| `get_volume_profile` 的 HVN / LVN | `volumeProfile()` 出 POC / VAH / VAL;高低成交量节点还没有消费方,先不做 |

反过来,本仓库比 8794 多出来的:`vwap`、`keltner`、`squeeze`、`donchian`、`supertrend`、`ichimoku`、`percentileRank`、`swingPoints`、`indicatorSnapshot` / `describeIndicators`(8794 没有任何把指标浓缩成一行给模型的函数——它的 `get_indicators` 直接吐原始 JSON)。
