# 现货(Spot)接入 + 交易市场维度(perp|spot)+ 期现套利地基 — 设计稿

日期:2026-09-21。分支 `okx-devday`。起因:切到 okx CLI 后,风控「最小仓验证止损」在简单模式账户(`acctLv=1`)上打永续单被 OKX 拒(51010),
而**现货在 acctLv=1 下就能交易**。顺势把「市场类型」做成一等维度:交易处可选 spot/perps,
后期用 ASP 的套利信号做期现套利(spot 多 + perp 空)的地基。

分工:后端(gateway)与前端(webui)分开实现。契约见 `docs/demo/v3-ui-contract.md` §9.40,先写契约再动手,两边只认契约。

## 0. 结论先行

- 新增类型 `Market = 'perp' | 'spot'`,**默认 `'perp'`**,所有旧数据/旧请求不带该字段一律按 perp 解释;Binance 通道只支持 perp(收到 spot 请求 → `local_reject: market_unsupported`)。
- **内部符号不变**(`BTCUSDT`),market 是符号旁边的独立字段,不做 `SPOT:BTCUSDT` 这种命名空间。
  OKX 侧换算:`perp → BTC-USDT-SWAP`(张数=qty/ctVal),`spot → BTC-USDT`(sz 直接是币的数量,`--tdMode cash`)。
- spot 语义:只有 `long`(买入持有)和 `flat`(卖出);`leverage` 固定 1、`margin_mode` 无意义(存 `cross` 占位,前端不显示);没有资金费、没有 OI、没有标记价(mark = last);止损 = `spot algo place --ordType conditional --side sell --sz <base 数量> --slTriggerPx --slOrdPx -1 --tdMode cash`;平仓 = 市价卖出全部可用余额(base ccy);没有 reduceOnly(减仓就是卖一部分)。
- 账户模式前置检查:`start()` 读 `account config` 的 `acctLv`;`acctLv=1` 时 perp **不可用**(不是通道不可用),`/api/execution` 回显 `okx.acct_lv` 与 `okx.markets_available`,任何 perp 下单前置拒绝并给出中文原因(不再让用户看裸 51010);spot 照常。
- 期现套利地基(本轮只做数据面):`GET /api/market/basis?symbol=` 给出 spot last / perp mark / 基差 / 资金费年化;线程加 `market` 与 `pair_id`(可空,留给以后把 spot 腿与 perp 腿绑成一对);ASP 入站信号解析出 `kind:'arbitrage'` 的先落账本不执行。
- 不做:spot 杠杆(margin)交易、spot 做空、多 TP 拆腿、双向持仓。

## 1. 类型与数据(gateway `types.ts` / 迁移)

- `export type Market = 'perp' | 'spot'`;`MARKETS = ['perp','spot']`。
- `StrategyThread` 加 `market: Market`(必填,迁移 `0024_market.sql`:`threads` 加列 `market TEXT NOT NULL DEFAULT 'perp'`;`intents`/`protection_credentials` 同样加列,凭据唯一键扩成 `(channel, symbol, market)`)、`pair_id: string | null`。
- `Workflow` 加 `markets: Market[]`(允许交易的市场,默认 `['perp']`;spot 不在列表里时 agent 提案与手工单的 spot 都被拒)、`default_market: Market`(默认 `'perp'`,交易页初始选中)。
- `ManualOrderRequest` 加 `market?: Market`;spot 时 `side` 只接受 `long`,`action:'close'` = 卖出;`leverage/margin_mode` 忽略;`margin_usdt` 语义改为「花多少 USDT」;`qty` 是币数量。
- `PositionView` 加 `market: Market`;spot 持仓来源 = `account balance` 里 base ccy 的 `availBal+frozenBal`(≥ 该币 spot 规则 minSz 才算持仓),`side:'long'`、`leverage:1`、`entry_price` = 本仓库线程的 `filled_avg_price`,线程外持有的用 `spot fills` 近 3 天成交的成本均价,算不出就 `mark`(并在 `note` 说明);`mark_price` = spot last;`unrealized_pnl` = (last−entry)×qty。
- `OpenOrderView` 加 `market`。
- `MarketView` 的 `funding_rate/next_funding_at/open_interest` 对 spot 置 `'0'/0/'0'`(类型不改),新增 `market: Market`。
- `Proposal`(schema.ts)加可选 `market`(缺省 perp);spot 提案 `direction` 只许 `long`,否则校验失败 `spot_no_short`。
- `SymbolInfo`/`SymbolRules` 按 `(symbol, market)` 缓存;`GET /api/symbols?market=spot` 返回 spot 可交易列表(OKX `instType=SPOT`、`quoteCcy=USDT`、`state=live`)。

## 2. ExecBackend 接口(`execution.ts`)

所有按 symbol 操作的方法加**尾参 `market: Market = 'perp'`**(默认值保证 paper/Binance 各通道零改动):
`symbolRules(symbol, market)`、`markPrice(symbol, market)`、`placeStop(symbol, position, stop, cid, market)`、`placeTakeProfit(...)`、`algoOrderExists(symbol, cid, market)`、`cancelAlgoOrder`、`listAlgoOrders(symbol, market)`、`closePosition(symbol, cid, market)`、`reducePosition(symbol, qty, cid, market)`、`cancelAll(symbol, market)`、`cancelOrder(symbol, cid, market)`、`getOrder(symbol, cid, fresh, market)`、`settlement(symbol, start, end, fresh, market)`。
`EntryRequest`/`OpenWithProtectionRequest` 加 `market: Market`。
`setLeverage/setMarginType` 在 spot 下**不调用**(runtime 分支跳过)。
新增 `marketsSupported(): Market[]`(paper: 两个都支持,paper 的 spot = 无杠杆多头账本;Binance 四通道 `['perp']`;okx: 按 acctLv,`1 → ['spot']`,`≥2 → ['perp','spot']`)。
新增可选 `spotHoldings?(): Promise<{ccy, total, available, usdt_value}[]>`(okx 实现,执行页展示)。

## 3. OKX 适配(`execution-okx.ts` / `okx/instruments.ts` / `market-okx.ts`)

| 方法 | perp(现状) | spot(新增) |
|---|---|---|
| instId | `BTC-USDT-SWAP` | `BTC-USDT`,`parseSpotInstruments`: `instType=SPOT`,`quoteCcy=USDT`;`step=lotSz`,`min_qty=minSz`,`tick=tickSz`,`min_notional=minSz×last`(OKX spot 还有 `minSz` 按 USDT 的情况,取大者) |
| placeEntry | `swap place --tdMode cross` | `spot place --instId --side buy/sell --ordType market/limit --sz <币> --tdMode cash --tgtCcy base_ccy --clOrdId` |
| openWithProtection | swap 附带 sl | `spot place ... --slTriggerPx --slOrdPx -1 --slTriggerPxType last`(spot 用 last 触发,没有 mark);附带腿 algoId 从 `spot get` 的 `attachAlgoOrds` 取,取不到 `unknown`,规则同 perp |
| placeStop | swap algo conditional reduceOnly | `spot algo place --instId --side sell --sz <当前可用 base 余额> --ordType conditional --slTriggerPx --slOrdPx -1 --slTriggerPxType last --tdMode cash --clOrdId`;**没有 cxlOnClosePos**:平仓时必须先撤算法单再卖(closePosition 顺序:cancelAll → sell) |
| algoOrderExists/listAlgoOrders/cancelAlgoOrder | `swap algo orders/cancel` | `spot algo orders --ordType conditional` + `oco`,`spot algo cancel` |
| closePosition | `swap close` | 撤该 instId 全部普通单与算法单 → `spot place --side sell --ordType market --sz <availBal 向下取整到 lotSz> --tdMode cash`;余额 < minSz → `closed:true`(视同无仓,等价 51023);卖单被拒 → `closed:false` |
| reducePosition | swap reduceOnly | `spot place --side sell --sz <qty>` |
| getOrder | `swap get` | `spot get --instId --clOrdId`,state 映射同;`accFillSz` 直接是币 |
| settlement | swap fills + bills | `spot fills`(近 3 天,>3 天 archive);`realized_pnl` OKX spot 不给,**由线程按 FIFO 从买卖成交算**(runtime 已有 filled_avg_price,平仓成交价−均价)×qty−手续费;`funding = null`(前端显示「现货无资金费」);覆盖证明同 perp |
| account() | 现状 | 追加 spot 持仓(§1 规则)进 `positions`,`market:'spot'`;挂单查询多两条 `spot orders` + `spot algo orders`,任一失败整份快照失败(规则同 perp) |
| start() | posMode 检查 | 追加读 `acctLv`,写 `okx.acct_lv`;`instruments --instType SPOT` 拉一次并缓存 10 分钟 |

clOrdId 规则不变。spot 与 perp 同一 symbol 的 KV 键前缀分开:`okx.algo.v1:spot:<cid>`。

行情(`market-okx.ts`):`fetchKlines/fetchTicker24h` 加 `market` 尾参(spot 打 `BTC-USDT` 的 candles/ticker);`fetchPremiumIndex/fetchOpenInterest*` 在 spot 下直接返回零值不发请求;新增 `fetchBasis(symbol)`:并发取 spot ticker `last`、perp mark-price、funding-rate,算 `basis_pct = (perp_mark − spot_last)/spot_last×100`、`funding_annualized_pct = fundingRate × 3 × 365 × 100`(8h 结算;OKX 部分币 4h,用 `nextFundingTime−fundingTime` 推周期)。

## 4. runtime(`runtime.ts` / `threads.ts` / `portfolio.ts` / `gates.ts`)

- 开仓路径按 `t.market` 分支:spot 跳过 setLeverage/setMarginType,`margin_usdt = qty×price`,`leverage = 1`。
- 组合容量(`portfolio.ts`):spot 腿的 `margin_per_thread = notional`(全额占用),进同一个 `max_margin_ratio` 预算;`available` 沿用 USDT `availBal`。
- 保护自检(`verifyProtection`)加 `market` 参数:spot 流程 = 买最小 lot(市价)→ `placeStop`(spot 条件单)→ `algoOrderExists` → 撤 → 市价卖回;凭据键 `(channel, symbol, market)`;`POST /api/execution/verify-protection` body 加 `market`。
- `hasLiveStop()` 对 spot 认 `STOP_MARKET`(spot 条件单翻译成同一内部词表:带 `slTriggerPx` 的 conditional/oco → `STOP_MARKET`,`side:'SELL'`,`reduce_only:true`)。
- 每日开仓计数、线程槽位、日亏停:不分市场,共用。
- 事件/告警文案带市场标签(`[spot]`)。
- ASP 入站(`asp-agent/inbox.ts`):信号里出现 `arbitrage|basis|funding` 关键字或结构化 `kind:'arbitrage'` 的,归一成 `{kind:'arbitrage', symbol, spot_side:'long', perp_side:'short', basis_pct?, expected_apr?}` 落 `market_signals`,`reason: 'arbitrage_recorded_only'`,不进 book 模式;前端信号行显示「套利·仅记录」。

## 5. 前端(webui)

- `api/types.ts`:`Market`、线程/持仓/挂单/工作流/手工单/执行视图新字段;`BASIS` 类型。
- 交易页(`pages/trade.tsx`):表单顶部 **Perps / Spot** 分段开关(初始 `workflow.default_market`,不在 `workflow.markets` 里的项置灰并提示);spot 模式:四象限收成「买入 / 卖出」两键,隐藏杠杆与全逐仓,金额字段文案改「花费 USDT」,名义 = 花费,止损参考价改按百分比默认 −3%;提交带 `market`。持仓表加「市场」列,spot 行杠杆显示「现货」;线程详情显示市场徽标;挂单表同。
- 工作流表单:`markets` 多选(perp/spot)+ `default_market`。
- 执行页:OKX 块加「账户模式」行(acctLv 文案:1 简单模式 / 2 单币种保证金 / 3 跨币种 / 4 组合保证金)与「可交易市场」徽标;acctLv=1 时给出切换指引(网页 → 交易 → 账户模式)与 51010 说明;spot 持币列表(`spot_holdings`);保护验证按钮按市场各一个。
- 行情页:symbol 头部加「基差」条(spot last / perp mark / 基差 % / 资金费年化),数据来自 `/api/market/basis`,30s 轮询。
- 信号市场:`kind:'arbitrage'` 行的展示。
- i18n 补键。

## 6. 验证(模拟盘)

1. `okx --profile okx-demo spot place --instId SOL-USDT --side buy --ordType market --sz 0.1 --tdMode cash` 手工跑通一次,确认 demo 账户 spot 有余额。
2. 执行页 acctLv 显示正确;`markets_available` 与账户匹配。
3. 交易页 spot 买入 SOL 最小额 → 持仓表出现 spot 行 → 挂止损 → `hasLiveStop` 认得 → 平仓卖出 → 结算给出成交与手续费、funding null。
4. spot 保护自检通过后 spot 侧不再提示未验证;perp 在 acctLv=1 下前置拒绝且原因可读。
5. `/api/market/basis?symbol=BTCUSDT` 有数;行情页基差条显示。
6. 全套 vitest 绿(新增 spot CLI 假规则、fake-okx-server 的 SPOT instruments/ticker)。

## 实现备注（2026-09-21，后端）

- 按仓库实际表名迁移 `demo_threads` / `demo_intents`。旧保护凭据原为 `demo_kv` JSON，0024 新建 `protection_credentials` 复合主键表并迁移旧记录；兼容 KV 读写接口，保存时同步关系表。旧记录缺省市场为 perp。
- 为兼容既有调用方，请求及执行方法的市场参数允许省略，入口统一补 perp；持久化线程、账户视图明确携带市场。spot/perp 同币使用独立缓存及持仓键，预算与槽位共用。
- CLI 1.4.7 的 `spot fills` 不透传 archive，也没有分页参数。超过三天或单页无法证明覆盖的现货结算返回 null，延后到 CLI 提供历史查询/分页支持后补齐；不把残缺成交当完整结算。现货资金费为 null，未知持币成本使用现价并附估算说明。
- 现货部分卖出后立即恢复剩余数量的保护，绕过常规重试冷却。外部已有止损的现货部分卖出先接管为线程；现货止损必须覆盖线程数量。纸面现货按本金收支和手续费记账，分次退出收益累计。
- 基差资金费年化优先使用实际结算周期，缺少有效周期时使用八小时默认值；缺少任一市场返回 basis_unavailable。
- 按本次任务限制，§6 的人工 CLI 下单演练未执行；验证全部使用注入 spawnFn、假行情服务及纸面账本，没有真实订单。

## 状态(2026-09-21 02:10)

- 后端与前端都已落地;gateway vitest 99 文件 / 1884 项全绿(两方各跑一遍),webui `tsc --noEmit` + `vite build` 过。
- 18811/5191 已重启到新代码。模拟盘实跑:`POST /api/execution/verify-protection {symbol:SOLUSDT, market:spot}` 全流程通过(买 0.010501 SOL @109.95 → 现货条件单止损 104.42 → 交易所查到 → 撤 → 市价卖回 → 确认无持仓),凭证 `(okx, SOLUSDT, spot)` 已签发 7 天。
- `/api/execution` 回显 `acct_lv:1 / 简单模式 / markets_supported:['spot']`;demo 账户自带的 BTC 1 / OKB 100 / ETH 1 以 spot 持仓出现。
- 开发实例的工作流已被改成 `markets:['perp','spot'], default_market:'spot'`(为了能在简单模式下交易)。
- 已知边界:CLI 1.4.7 的 `spot fills` 无归档/分页,>3 天现货结算返回 null;demo 自带现货持币会触发「无主·没有止损」告警(现货是否必须有止损待拍板);`spot_holdings.usdt_value` 直接透传 CLI 的浮点串。

## 现货止损可选（2026-09-21）

Owner 已确认：spot 不要求止损。无止损的现货线程、手工订单、接管持仓及 book 跟单为正常路径，展示「现货,无止损(可选)」；提案按整仓名义金额承担风险（无止损距离按 100%），手工单按 `margin_usdt` 花费。现货开仓不依赖保护凭据；已有现货凭据保留展示，手动 `verify-protection` 仍可用，但不参与保护汇总、未验证告警或自动续验。现货设置了止损则继续挂单、缺失补挂与失败告警。无止损现货及无主现货不计入缺保护指标/告警；无主对账提示可保留。永续规则不变。本次仅假执行测试，无真实订单。

## 02:45 追加:现货止损可选 + 永续不可用时的无缝切换

- 现货不强制止损(Jacky 拍板):spot 从保护闸 / never_verified / 缺止损告警 / PROTECTION_MISSING 巡检全部豁免,带止损的现货线程照旧守;提案与手工单在 spot 下止损可空。后端由 外部评审落地(内部评审记录,1898 测绿);前端接管对话框对现货把止损改可选、无主现货不再标「没有止损」。
- 永续在简单模式下的处理:交易页「永续」不是死按钮,点了弹框讲清 51010 原因 + 「去 OKX 切换」按钮(打开 OKX 交易页,右上角账户模式),同时每 5 秒 `POST /api/execution/okx/account-level/refresh`(网关重读 `account config` 的 acctLv,只读),模式一变永续自动亮起并切过去。CDP 实测:弹框出现、轮询按 5 秒打到网关。
- 真正一键切换(网关自己打 `set-account-level`)取决于 OKX 是否允许 API 切:`scripts/okx-set-account-level.py` 由 Jacky 自己跑一次确认(工具层拦签名请求);允许则加 `POST /api/execution/okx/account-level {acctLv}`,前提是没有持仓/挂单/借币;首次切出简单模式很可能被要求先做 App 测评,那就只能走上面的链接+轮询路。
- 18811/5191 已重启到含这些改动的代码;整包仍未提交。
- **02:55 实测结论**:`set-account-level` API 在这个 demo 账户上返回 **51070**「You do not meet the requirements for switching to this account mode. Please upgrade your account mode on the OKX website or app」——从简单模式切出必须在网页/App 做(合约风险测评),API 路不通。所以「一键切模式」不做,交易页的「链接 + 5 秒轮询自动亮起」就是终态;`scripts/okx-set-account-level.py` 留作以后(账户已升级过一次后)的切回/切换工具。
- **03:50 账户模式切换已接进网关**:`okx-account-mode.ts`(极简 TOML 读 profile 三件套 → HMAC 签名 → `set-account-level`,demo 头,site 基址映射)+ `POST /api/execution/okx/account-level`;执行页「OKX 接入」块的账户模式徽标改成下拉(1/2/3/4,带确认框与前置持仓提示)。实测 demo 账户 3→2→3 两次都 `code 0`,网关日志 `acctLv 3 → 2`、`2 → 3`,`markets_supported` 同步刷新。51070 只在从简单模式首次切出时出现,那一步仍要网页做。
