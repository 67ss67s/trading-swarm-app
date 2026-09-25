# exec-core —— REST / 主账户半边(A1)

从 8794(`~/Desktop/trade-switch-dev-8793`,实盘基线)**复制**出来的纯执行逻辑,剥离 `console_types`/`TradingCore` 后独立演进;不引用、不回改那边。凭证只从 env(`TG_MAIN_API_KEY`/`TG_MAIN_API_SECRET`)或 `~/.trading-swarm/secrets/apikey-main.json`(0600)读,**不接受命令行传密钥**。**不实现任何提币端点**(设计 §16 Q7)。

## 来源与删改

| 本 crate | 来源(8794) | 保留 | 删掉/改写 |
|---|---|---|---|
| `binance::rest` | `console-core/exchanges/binance.rs` 的 `signed_query`/`sync_server_time`/`signed_request`/`urlencode`/重试 | HMAC 签名、服务器时间偏移(30min 同步,-1021 立即重同步重签一次)、幂等请求有限重试 | `test_order`/`allow_live_orders`/hedge 联锁/币本位探测/copy_trading;时间偏移与令牌桶从 static 改实例字段 |
| `ratelimit` | 同上的令牌桶 + `RestGate::{Ready,Wait,Banned}` | 720 权重/分钟、封禁一秒不等、`Retry-After`/`X-MBX-USED-WEIGHT-1M` 自适应 | — |
| `error` | `BinanceError` 判定函数 | 归成 `kind`:LocalReject / Unauthorized / ClockSkew(-1021/-1022) / RateLimited / **Transport(ambiguous:5xx、-1007、断连)** / Rejected | 8794 R60 教训:带 JSON body 的 5xx 曾被记成 rejected |
| `binance::futures` | USDⓈ-M 端点 | account/balance/positionRisk/positionSide/leverage/marginType/openOrders/order(POST 带 `newClientOrderId`、GET/DELETE 按 orderId 或 origClientOrderId)/allOrders/userTrades/income/listenKey/exchangeInfo/premiumIndex/ticker/klines | TWAP、algo 订单、COIN-M、跟单 |
| `binance::spot_sapi` | 新写(8794 只有 copyTrading 的 sapi) | `apiRestrictions`、`/api/v3/account`、`sub-account/list`、`sub-account/assets`、`spotSummary`、`universalTransfer`(GET 历史 / POST 动钱)、`asset/transfer`(主账户 spot↔UM) | 提币 |
| `account_stream` | `console-api/account_stream.rs` | 用户数据流缓存:**断流即 stale**(在线 600s、断线只认 10s 内的 REST 对账)、REST 节流、`ORDER_TRADE_UPDATE`/`ACCOUNT_UPDATE` 合并(WS 增量不抹 REST 字段;`i:0` 占位不覆盖真 orderId)、写完单 `invalidate_orders` | 与 TradingCore 的耦合 |
| `network` | `console-api/network.rs` + WS 代理连接 | 代理 env 六变量归一化、回环 bypass、`connect_ws_via_proxy`(CONNECT/SOCKS5) | 设置页语义 |
| `filters` / `ids` | `SymbolRules`/`decimal_text`/`allocate_lots`;clientOrderId | `decimal_text` 修过 float 尾巴导致 -1111 的 bug;`tg-` 前缀本机、`ts_`(8794)算外部 | — |
| `secrets` | 新写 | `SecretString`(Debug/Display 脱敏)、0600 强制 | — |

## 探针 `tswarm-rest-probe`(默认全只读)

```
export TG_MAIN_API_KEY=... TG_MAIN_API_SECRET=...        # 或写 ~/.trading-swarm/secrets/apikey-main.json(chmod 600)
CARGO_TARGET_DIR=target/exec-core cargo run -p exec-core --bin tswarm-rest-probe -- --json-out docs/research/a1-main-key-probe.json [--show-balances]
```

步骤:服务器时间偏移 → `apiRestrictions`(enableWithdrawals=true 会红字)→ 现货余额概要 → 合约账户 + 持仓模式 → `sub-account/list`(每行除 email 外**全部字段原样保留**,自动标 looks_agentic)→ 每个子账户 `sub-account/assets` → 万能划转历史。**动钱**分支 `--transfer-test --asset USDT --amount 1 --to-email <sub>` 还必须 `TG_ALLOW_TRANSFER=1`,由主线在 Jacky 放行后亲自跑。

A1「三件事」判据(设计 §3.5):①Agentic virtual sub 是否出现在 `sub-account/list`(看 `findings.q1_*` 与 `looks_agentic`);②`universalTransfer` 能否对它划转(`findings.q2_*`,需 --transfer-test);③`sub-account/assets` 能否读它(`findings.q3_*`)。任一不通,Funding 页对应按钮退化为 Binance UI 深链。

## 测试

`CARGO_TARGET_DIR=target/exec-core cargo test -p exec-core`(71 条:签名向量、查询串、`decimal_text` 回归、lots 分配、filters、RestGate/令牌桶、错误归类、ids、用户流缓存、代理 env、axum 假服务器验请求形状)。不碰带凭证的真实端点。
