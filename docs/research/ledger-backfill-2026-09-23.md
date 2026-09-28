# 判断账本历史回填:提前离场到底有多贵(2026-09-23)

> 工单:`docs/design/judgment-exit-redesign-2026-09-23.md` §6 P0-1。零模型调用,不改交易行为。
> 数据:主库 `~/.trade-gate/demo/state.sqlite`(18801)的 `.backup` 副本;**现网库没有写过一个字节**。
> K 线:`~/.trade-gate/demo/klines` 的一份副本(scratchpad);只有 KORUUSDT 15m/1h 缓存里没有,补拉了几次币安 fapi 公共 K 线,写进的也是副本。所有需要的区间都拿到了,没有缺 K 线的行。

## 0. 结论

1. **提前离场在这批样本里既没多赚也没多亏。** 9 次 EXIT 的离场价合计 −1.47R;同样 9 笔从离场那一刻起按原计划拿到止损或止盈,合计 −1.30R(6 笔止损、3 笔止盈)。去掉触硬止损的 ZEC 和一笔被重建失真的 SKHYNIX,剩下 7 次主观离场合计 −2.11R,拿到计划是 −2.65R:离场一共省了 0.54R,平均每笔 0.08R。算法是 5 笔亏损单少亏 2.51R,再减去砍掉的 2 笔盈利单少赚的 1.97R。
2. **模型的复查判断没有比两条傻策略好。** 在仓复查 254 行(16 个线程)上,模型实际选择的 regret 按行均值 0.29R、按线程均值 0.37R;「永远拿着」同样是 0.29 / 0.34,「每次都立刻走」是 0.24 / 0.31。模型 245 次 HOLD、9 次 EXIT,几乎等于「永远拿着」。
3. **量出来更大的一笔成本是「该走没走」,不是「走早了」。** HOLD 行的 regret_hold 均值 0.29R,24% 的 HOLD 超过 0.5R(48 根内 64 次止损、49 次止盈、132 次到期)。注意这是事后指标:一笔单最后打到止损,它之前的每次 HOLD 都会带上 regret,所以只能拿它和上面两条基线比,不能拿它和 0 比。
4. **机械吊灯线(ATR22×3,入场起追踪、不设止盈)是三种管理里唯一没亏的。** 18 笔已平线程合计 +0.16R;「入场后什么都不管,只看计划止损止盈」是 −3.93R。14 笔有离场价的线程上,实际毛 R 合计 −6.17R,同样这 14 笔用吊灯线是 −2.52R。
5. **09-09 之后的持仓闸,线上样本只有 6 行**(thesis_intact 3 行、no_fresh_closed_thesis_bars 2 行、hard_stop_touch 1 行),**什么也说明不了**。其余 256 行都早于这道闸,holding_reason 记为 `unknown`。
6. 没有一个分层能过样本门槛(有效配对 ≥ 10 且独立簇 ≥ 10)。上面的数字只能用来定方向,不能用来下结论。

## 1. 回填了什么

| 项 | 数 |
|---|---|
| 有 thread_id、账本里还没有行的 episode | 340 |
| 写入 `source='backfill'` 的行 | **294**(review 271 / scan 23) |
| 跳过 | 45 个 failed、1 个卡在 running 的 episode(都没有判断结果) |
| review 行里 regret 算得出来的 | **262 / 271**。剩下 9 行是 CRCL 已撤单线程的挂单复查,用终态重建出来的挂单几何不合法,`simulateOutcome` 返回 invalid |
| 涉及线程 | 18 条已平 + 9 条已撤(挂单阶段) |
| 在仓复查行(in_position) | 254 行 / 16 个线程:HOLD 245、EXIT 9 |
| 挂单复查行(pending_entry) | 8 行,其中 INVALIDATE 3 行 |
| 原有账本 | online 2113 行(review 只有 5 行,全部来自 09-12 之后的 thr-mtxoli1f22f067,不在这批线程里)、trader 471 行 |

口径(每一行的 settle_note 里都写了):

- **复查快照用的是线程终态**,即 `reviewSnapshot` 的重建路径,不是判断当时的止损/止盈/成交价。挪过止损或止盈的线程,早期那些行的 R 基数会偏。SKHYNIX(thr-mtr04zyk37ee72)就是例子:离场判断那一刻 exit_now_r = 1.77R,已经高过终态止盈对应的 1.57R,说明当时挂着的止盈价和终态不一样。
- regret 走**线程自己的周期**(新加的 `review_bars`),horizon 48 根:1m 线程是 48 分钟,15m 线程是 12 小时。15m 线程里有 48 行的第一条结构证据写的是 1h,如果不换成线程周期,它们的 horizon 会被拉到 48 小时。
- 09-05 之前的 episode(v2 到 v7.1)结构证据按价位取整,价格 >100 时 ATR 直接被写成 `ATR14 0`,快照读不出来。这些行的三条腿都不可评分;现在 regret 改用行情证据里的标记价加线程周期来算,不再跟着快照一起丢。
- **by_decision 不按结算完整性剔行**:regret 只读计划和 K 线,不读交易所净额。现有 `overall` / `by_strategy` 仍然按 P1-13 剔除,294 行里有 142 行被排除(6 条 paper 线程没有交易所结算),所以 `overall.review_regret` = 0.42,算的是另外那 127 行。

## 2. by_decision(mode=review,按 model_action × holding_reason × trigger_kind × prompt_version 分组)

均值按行算,「簇」= 独立线程数。每一格都 insufficient。

| action | holding_reason | trigger | prompt | n | 簇 | mean regret | mean hold_r | mean exit_now_r | mean regret_hold | EXIT regret>0.5R |
|---|---|---|---|---|---|---|---|---|---|---|
| HOLD | unknown | kline_close | v2 | 104 | 2 | 0.16 | 0.26 | 0.25 | 0.16 | — |
| HOLD | unknown | info_update | v8 | 37 | 3 | 0.16 | 0.92 | 0.67 | 0.16 | — |
| HOLD | unknown | heartbeat | v8 | 20 | 4 | 0.67 | -0.60 | -0.07 | 0.67 | — |
| HOLD | unknown | info_update | v7.1 | 18 | 3 | 0.55 | -0.61 | -0.07 | 0.55 | — |
| HOLD | unknown | heartbeat | v6 | 11 | 2 | 0.73 | -0.12 | 0.60 | 0.73 | — |
| HOLD | unknown | breakout | v8 | 8 | 2 | 0.16 | 1.09 | 0.94 | 0.16 | — |
| HOLD | unknown | heartbeat | v7.1 | 7 | 2 | 0.66 | -0.47 | 0.18 | 0.66 | — |
| HOLD | unknown | heartbeat | v5.1 | 5 | 1 | 0.00 | 1.34 | 0.19 | 0.00 | — |
| HOLD | unknown | breakout | v5.1 | 4 | 3 | 0.02 | 1.07 | 0.40 | 0.02 | — |
| HOLD | unknown | funding | v8 | 4 | 2 | 0.39 | -0.34 | -0.06 | 0.39 | — |
| HOLD | unknown | retest | v8 | 3 | 1 | 0.83 | -1.00 | -0.17 | 0.83 | — |
| HOLD | unknown | vol_spike | v5.1 | 3 | 3 | 0.00 | 0.91 | 0.15 | 0.00 | — |
| HOLD | unknown | vol_spike | v7.1 | 3 | 3 | 0.28 | 0.00 | -0.16 | 0.28 | — |
| HOLD | unknown | vol_spike | v8 | 3 | 1 | 0.00 | 1.64 | 1.01 | 0.00 | — |
| HOLD | thesis_intact | heartbeat | v9-holding | 2 | 1 | 1.00 | -1.00 | 0.00 | 1.00 | — |
| HOLD | unknown | breakout | v7.1 | 2 | 2 | 0.49 | -0.61 | -0.12 | 0.49 | — |
| HOLD | unknown | fast_move | v8 | 2 | 2 | 0.29 | -0.08 | -0.04 | 0.29 | — |
| HOLD | unknown | info_update | v5.1 | 2 | 2 | 0.00 | 0.82 | 0.07 | 0.00 | — |
| HOLD | unknown | session | v8 | 2 | 2 | 0.30 | 0.29 | 0.14 | 0.30 | — |
| EXIT | hard_stop_touch | fast_move | v9-holding | 1 | 1 | 0.00 | -1.14 | -1.13 | — | 0% |
| EXIT | unknown | breakout | v8 | 1 | 1 | 0.72 | 2.48 | 1.77 | — | 100% |
| EXIT | unknown | heartbeat | v6 | 1 | 1 | 0.00 | -1.00 | -0.16 | — | 0% |
| EXIT | unknown | heartbeat | v7.1 | 1 | 1 | 0.00 | -0.45 | -0.17 | — | 0% |
| EXIT | unknown | heartbeat | v8 | 1 | 1 | 0.00 | -1.00 | -0.69 | — | 0% |
| EXIT | unknown | info_update | v7.1 | 1 | 1 | 0.60 | 0.95 | 0.34 | — | 100% |
| EXIT | unknown | kline_close | v2 | 1 | 1 | 0.50 | -0.44 | -0.93 | — | 0% |
| EXIT | unknown | vol_spike | v5.1 | 1 | 1 | 1.36 | 1.41 | 0.05 | — | 100% |
| EXIT | unknown | vol_spike | v7.1 | 1 | 1 | 0.00 | -0.65 | -0.54 | — | 0% |
| HOLD | no_fresh_closed_thesis_bars | fast_move | v9-holding | 1 | 1 | 1.00 | -1.00 | 0.00 | 1.00 | — |
| HOLD | no_fresh_closed_thesis_bars | heartbeat | v9-holding | 1 | 1 | 1.00 | -1.00 | 0.00 | 1.00 | — |
| HOLD | thesis_intact | retest | v9-holding | 1 | 1 | 0.12 | -1.00 | -0.88 | 0.12 | — |
| HOLD | unknown | breakout | v6 | 1 | 1 | 1.16 | -1.00 | 0.16 | 1.16 | — |
| HOLD | unknown | ema_cross | v8 | 1 | 1 | 1.43 | -1.94 | -0.50 | 1.43 | — |
| HOLD | unknown | fast_move | v5.1 | 1 | 1 | 0.00 | 1.32 | 0.77 | 0.00 | — |
| HOLD | unknown | manual | v6 | 1 | 1 | 0.41 | 0.07 | 0.48 | 0.41 | — |
| HOLD | unknown | order_filled | v2 | 1 | 1 | 0.00 | 0.45 | 0.06 | 0.00 | — |
| HOLD | unknown | order_filled | v7.1 | 1 | 1 | 0.23 | -0.32 | -0.10 | 0.23 | — |
| HOLD | unknown | retest | v7.1 | 1 | 1 | 1.18 | -1.00 | 0.18 | 1.18 | — |
| INVALIDATE | unknown | fast_move | v5.1 | 1 | 1 | 0.00 | 0.00 | 0.00 | — | 0% |
| INVALIDATE | unknown | info_update | v8 | 1 | 1 | 1.42 | 1.42 | 0.00 | — | 100% |
| INVALIDATE | unknown | vol_spike | v8 | 1 | 1 | 1.42 | 1.42 | 0.00 | — | 100% |


边际分层(同一批 262 行,行均值 regret;括号里是行数 / 簇数):

- **按 prompt_version**:v2 0.16(106/2)、v5.1 0.09(17/4)、v6 0.68(14/2)、v7.1 0.53(35/5)、v8 0.37(84/7)、v9-holding 0.69(6/3)。
- **按 trigger_kind**:heartbeat 0.59(49/10)、retest 0.76(5/2)、info_update 0.30(59/9)、vol_spike 0.30(12/8)、breakout 0.27(16/8)、fast_move 0.26(6/6)、kline_close 0.17(105/2)。
- **按 holding_reason**:unknown 0.30(256)、thesis_intact 0.71(3)、no_fresh_closed_thesis_bars 1.00(2)、hard_stop_touch 0.00(1)。
- **按线程周期**:1m 0.16(106 行 / 2 簇,线程均值 0.36)、15m 0.41(156 行,线程均值 0.48)。

## 3. 逐线程(18 条已平线程)

- 「拿到计划」:从离场判断那一刻起(没有离场判断就从入场起)按终态止损/止盈一直拿着,最多 7 天。
- 「入场即不管」:入场后只看计划止损/止盈,完全不复查。
- 「吊灯线」:入场起止损 = max(计划止损, 入场后最高价 − 3×ATR22);ATR 和最高价都只用已收盘的 K 线,止损只收紧不放松,不设止盈,最多 7 天。`trail` 表示最后是被追踪止损带出场的。
- 「实际毛 R」:(平仓价 − 成交价)÷ |成交价 − 终态止损|,不含费用。平仓价取交易所结算的 exit_price,没有就用 EXIT 回执的 avgPrice。

| 币 | 周期 | 持有 min | 收场 | 复查行 | 离场动作 | holding_reason | 离场触发 | 离场 prompt | exit_now_r | hold_r (48 根) | regret | 拿到计划(离场起,≤7 天) | 入场即不管 | 吊灯线 ATR22×3 | 实际毛 R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SOL | 1m | 26 | 复查离场 | 16 | EXIT | unknown | kline_close | v2 | -0.93 | -0.44 | 0.50 | -1.00 stop | -1.00 stop | -0.37 trail | -0.84 |
| SOL | 1m | 94 | 交易所侧平 | 90 | — | — | — | — | — | — | — | -1.00 stop | -1.00 stop | 0.34 trail | — |
| BNB | 15m | 262 | 止盈 | 8 | — | — | — | — | — | — | — | 1.32 tp | 1.32 tp | 2.11 trail | — |
| SOL | 15m | 59 | 复查离场 | 5 | EXIT | unknown | vol_spike | v5.1 | 0.05 | 1.41 | 1.36 | 1.41 tp | 1.41 tp | -0.12 trail | 0.07 |
| BNB | 15m | 338 | 手动 | 13 | — | — | — | — | — | — | — | -1.00 stop | -1.00 stop | 0.55 trail | — |
| HYPE | 15m | 44 | 复查离场 | 3 | EXIT | unknown | heartbeat | v6 | -0.16 | -1.00 | 0.00 | -1.00 stop | -1.00 stop | -0.58 trail | -0.17 |
| HYPE | 15m | 1 | 补偿平仓 | 0 | — | — | — | — | — | — | — | -1.00 stop | -1.00 stop | -0.66 trail | -0.07 |
| SOXS | 15m | 1 | 补偿平仓 | 1 | — | — | — | — | — | — | — | 1.30 tp | 1.30 tp | 0.10 trail | 0.05 |
| SPCX | 15m | 345 | 复查离场 | 11 | EXIT | unknown | heartbeat | v7.1 | -0.17 | -0.45 | 0.00 | -1.00 stop | -1.00 stop | 0.01 trail | -0.27 |
| BNB | 15m | 11 | 复查离场 | 1 | EXIT | unknown | info_update | v7.1 | 0.34 | 0.95 | 0.60 | 0.95 tp | 0.95 tp | 0.89 trail | 0.34 |
| CRCL | 15m | 774 | 交易所侧平 | 30 | — | — | — | — | — | — | — | -1.00 stop | -1.00 stop | -0.25 trail | -2.43 |
| SKHYNIX | 15m | 0 | 交易所侧平 | 0 | — | — | — | — | — | — | — | 1.53 tp | 1.53 tp | -0.32 trail | — |
| XAUT | 15m | 88 | 复查离场 | 5 | EXIT | unknown | vol_spike | v7.1 | -0.54 | -0.65 | 0.00 | -1.00 stop | -1.00 stop | -0.48 trail | -0.57 |
| MU | 15m | 1187 | 交易所侧平 | 20 | — | — | — | — | — | — | — | -1.00 stop | -1.00 stop | 0.03 trail | -1.08 |
| SOXS | 15m | 156 | 交易所侧平 | 2 | — | — | — | — | — | — | — | -1.00 stop | -1.00 stop | -0.64 trail | -1.02 |
| SKHYNIX | 15m | 923 | 交易所侧平 | 42 | EXIT | unknown | breakout | v8 | 1.77 | 2.48 | 0.72 | 2.48 tp | 1.57 tp | 1.11 trail | 1.56 |
| DOGE | 15m | 224 | 复查离场 | 4 | EXIT | unknown | heartbeat | v8 | -0.69 | -1.00 | 0.00 | -1.00 stop | -1.00 stop | -0.57 trail | -0.72 |
| ZEC | 15m | 101 | 交易所侧平 | 3 | EXIT | hard_stop_touch | fast_move | v9-holding | -1.13 | -1.14 | 0.00 | -1.14 stop | -1.00 stop | -1.00 stop | -1.01 |

合计:入场即不管 −3.93R;吊灯线 +0.16R。有离场价的 14 条线程上:实际 −6.17R,入场即不管 −4.78R,吊灯线 −2.52R。

## 4. 观察

- **9 次 EXIT 里,拿着会到止盈的 3 次,会到止损的 6 次**(按拿到计划算,不限 48 根)。在 48 根 horizon 内是止盈 3、止损 3、到期 3。EXIT 的 regret 均值 0.35R,3/9 超过 0.5R:SOL 15m 1.36R、SKHYNIX 0.72R(但这笔的几何被重建污染了)、BNB 0.60R。
- **离场的净价值约等于 0**:5 笔亏损单一共少亏 2.51R(HYPE 0.84R、SPCX 0.83R、XAUT 0.46R、DOGE 0.31R、SOL 1m 0.07R),2 笔盈利单一共少赚 1.97R(SOL 15m 1.36R、BNB 0.61R)。和 §0.2 对上:模型离场没有表现出选择能力。
- **HOLD 比 EXIT 花得多**:245 次在仓 HOLD 的 regret_hold 合计约 71R(0.29R × 245);9 次 EXIT 的 regret 合计 3.2R。按线程看,HOLD 的 regret_hold 线程均值是 0.37R。提前离场的问题是真的,但它不是 R 流失的主要出口;主要出口是失效线/止损的几何,和设计文档 D1 的判断一致:软离场亏得少,硬止损亏满 1R,而止盈只有 1.3 到 1.6R。
- **heartbeat 触发的复查 regret 最高**(0.59R,10 个簇),info_update 和 breakout 大约只有它的一半。「心跳唤醒 → 没有新信息也要重新判断一遍」这条路径值得在 P1 里优先砍掉或降频。
- **1m 线程没有主导 regret**:行数占 40%,但每行 regret 只有 0.16R,因为 48 根 1m 只有 48 分钟,大多是按到期收盘价算的。1m 的代价在调用次数上(SOL 1m 一条线程 90 次复查),不在 regret 上。15m 线程的 regret 是 1m 的 2.5 倍。
- **prompt 版本之间看不出单调改善**:v5.1 0.09 → v6 0.68 → v7.1 0.53 → v8 0.37 → v9-holding 0.69,每一档只有 2 到 7 个簇,主要反映的是那几天的行情,不是 prompt 的好坏。
- **机械对照明显更好**:吊灯线在 18 笔上 +0.16R,入场即不管 −3.93R,实际 14 笔 −6.17R。两个原因:它不设 1.5R 止盈,BNB 跑到 +2.11R;它会把亏损单的止损往上收(SOL 1m 第二条从 −1R 变成 +0.34R,BNB 手动平那条从 −1R 变成 +0.55R)。样本只有 18 笔、单一时段,只能算方向证据,但方向和方案 B「几何交还代码」一致。
- **扫描期 PROPOSE 23 行**(18 行可评分)的模型腿均值 −0.17R,和机械腿**逐行完全相同**:18 次提议的方向全都等于 1h EMA20/50 的方向。那几天模型的开仓方向相对这枚硬币没有增量。议会腿全部 unknown,那时还没有议会。
- **CRCL 实际毛 R −2.43**,远超 −1R。原因是终态止损比开仓时近(R 基数变小),或者交易所侧平仓时滑点很大。这一列只作留痕,不要拿去比较。

## 5. 代码改动(可以复跑)

- `packages/gateway/src/demo/judgment-ledger.ts`(版本升到 `jl-v2`,旧行读的时候兼容)
  - 行上加了 `trigger_kind`、`holding_reason`(review 行取 `episode.holding_review.reason`,没有就是 `'unknown'`;scan 行为 null)、`prompt_version`、`mark`(判断时的标记价)和 `regret_hold`。
  - `LedgerRegret` 加了 `regret_hold`(HOLD/ADD 时 = max(0, exit_now − hold))和 `regret_exit`(EXIT/INVALIDATE 时 = max(0, hold − exit_now))。
  - `ledgerRowFor`:review 行的快照读不出来时,周期退回线程周期。
  - `settleRow(..., { review_bars })`:regret 可以用线程周期的 K 线;标记价退回到 `row.mark`。
  - `summarizeLedger` 新增 `by_trigger_kind` / `by_holding_reason` / `by_prompt_version` 三种分层(`LedgerStratum` 带 `dim` / `value`,新增 `review_regret_hold` / `review_hold_n`)和 `by_decision`(`summarizeDecisions`)。
  - `LedgerQuery.source` 加了 `'backfill'`。
- `packages/gateway/src/demo/routes-judgment.ts`:`GET /api/judgment-ledger` 和 `/summary` 支持 `?source=online|replay|trader|backfill|all`,默认仍是 online。
- `packages/gateway/scripts/ledger-backfill.ts`:回填脚本。路径是现网库时直接拒绝。
- 测试:`judgment-ledger.test.ts` 加了 5 个用例(regret_hold/regret_exit、分层键、快照丢失时 regret 仍能算、review_bars、by_decision 分组和旧行兼容);`judgment-ledger-http.test.ts` 加了 1 个 `?source=backfill` 用例。

复跑方法:

```bash
sqlite3 ~/.trade-gate/demo/state.sqlite ".backup /tmp/ledger-copy.sqlite"
cd packages/gateway
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 npx jiti scripts/ledger-backfill.ts \
  --db /tmp/ledger-copy.sqlite --klines-dir <缓存副本目录> --json /tmp/backfill.json   # 加 --dry-run 只算不写
```

### 需要别人落地的一处(本次禁改路径)

`source` 列由迁移里的触发器维护。backfill 没有对应的触发器,脚本目前是写完 json 以后直接 `UPDATE ... SET source='backfill'`。要让 `store.judgments.save()` 单独就能落对 source,需要在 `packages/gateway/src/migrations/` 下新增一个迁移(编号接当时最新的那个):

```sql
-- 00xx_judgment_backfill_source.sql
-- 判断账本历史回填(scripts/ledger-backfill.ts,09-23 P0-1):止损/止盈取线程终态重建,和 online 不是同一个实验。
CREATE TRIGGER demo_judgment_backfill_source_insert AFTER INSERT ON demo_judgment_ledger
WHEN json_extract(NEW.json, '$.source') = 'backfill'
BEGIN UPDATE demo_judgment_ledger SET source = 'backfill' WHERE episode_id = NEW.episode_id; END;
CREATE TRIGGER demo_judgment_backfill_source_update AFTER UPDATE OF json ON demo_judgment_ledger
WHEN json_extract(NEW.json, '$.source') = 'backfill'
BEGIN UPDATE demo_judgment_ledger SET source = 'backfill' WHERE episode_id = NEW.episode_id; END;
```

契约和前端(`packages/contracts`、`packages/webui`)还不认识这些新字段,它们都是可选的,旧前端照常能用。要在账本页展示 by_decision,需要另外补契约 §9.29。

## 6. 下一步

- 这次回填只在副本上跑。要不要对现网主库也跑一遍(会往 `demo_judgment_ledger` 写 294 行 `source='backfill'`,默认查询看不到),需要 Jacky 放行,并且最好先把上面的触发器迁移落地。
- 真正能回答「v9 之后的持仓闸有没有用」的样本只能等新的实盘线程。按现在的交易频率,要攒够 10 个簇,还需要先按设计文档 D5/D6 把开仓频率提上来。
