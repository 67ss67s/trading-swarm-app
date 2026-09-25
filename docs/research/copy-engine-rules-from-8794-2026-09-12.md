# 8794(trade-switch-dev-8793 / Trade Switch 控制台)跟单规则清点

- 只读调研,不改源码。仓库路径:`~/Desktop/trade-switch-dev-8793`(Rust,`backend/crates/{console-core,console-api,console-db,account-hub}`)。
- 本机确认在跑的实盘实例:`console-api --root ~/Desktop/trade-switch-dev-hedge --port 8794`(pid 33556,`ps aux` 现查),`GET /api/health` → `mode=live, auth_required=false`,`GET /api/auth/whoami` → `role=open`。运行态配置见 §5.3。
- 行号基于调研当时(2026-09-12)的工作树,可能随后续提交漂移;字段名/常量名更稳定,建议按名搜索定位。
- 每节按「规则 → 口径 → 源位置」列出,文末给"移植到 trading-swarm 最该保留的 10 条"与"8794 自己还没修好的坑"。

---

## 一、信号进入(bridge 拉取 → 内部订单意图)

### 1.1 订阅端点 / 游标 / 幂等键 / 鉴权 / 轮询间隔

| 规则 | 口径 | 源位置 |
|---|---|---|
| 拉信号端点 | `GET {bridge_url}/api/v1/subscriber/signals`,query 带 `after_id`(游标)、`limit`、`agent_id`、可选 `instance_id`、`wait_seconds`+`poll_interval_seconds`(长轮询) | `backend/crates/console-api/src/subscription.rs:382-411` |
| 鉴权 | 每次请求带 `X-API-Key` + `X-Secret-Token` 头(`subscriber_request`);自定义 `User-Agent: trade-switch-console-agent/0.9`(默认 UA 会被 Cloudflare error 1010 拦) | `subscription.rs:38-39, 348-353` |
| 身份/游标维护 | `agent_id`(缺省 `console-agent`)+`instance_id` 必须带上,供 bridge 维护 `subscriber_agent_progress`,否则"agent 卡住了"要 7 天才发现 | `subscription.rs:381-386` |
| 轮询节奏 | `interval_seconds`(默认 5s,普通轮询间隔)、`wait_seconds`(默认 10s,clamp 0~30,长轮询等待)、`bridge_poll_interval_seconds`(默认 0.5s,clamp 0.1~5,长轮询内部探测间隔)、`request_timeout_seconds`(默认 35s) | `subscription.rs:117-124` |
| 目标不可达退避 | 连续失败按 `interval_seconds × 2^(n-1)` 指数退避,封顶 `MAX_TARGET_BACKOFF_SECONDS=60s`;恢复后立即回到正常节奏 | `subscription.rs:216-234, 42-43` |
| 幂等/去重 | 投递给本机 console 的端点是 `POST {console_url}/api/v1/external/signals`,`Authorization: Bearer {console_ingest_token}`;去重靠信号侧 `signal_id`/`thread_key`(见 §1.3 生命周期分类),bridge 侧的"这条投过没"靠 `after_id` 游标 + 逐条/批量 ack | `subscription.rs:432-465` |
| 投递结果分类 | 四类处置:`Ok`→推进游标;`Unreachable`(无状态码/5xx)→整个目标故障,停下不逐条判死,等恢复;`Auth`(401/403)→凭据/配置错,停下告警不重试;`Reject`(其它 4xx)→单条有界重试(`max_delivery_attempts` 默认 3),超限写死信(DLQ)并推进游标 | `subscription.rs:172-207, 780-850` |
| 死信队列 | `dlq_file`(默认 `data/console_agent_dlq.jsonl`),留存 `signal_id/record_id/attempts/status_code/error_message/console_url/envelope` 全量,可 `POST /api/console-agent/replay-dlq` 重投 | `subscription.rs:606-627, 976-1046` |
| 启动补拉 | `startup_backfill_enabled`(默认 true)、`startup_backfill_recent`(默认 500,新装机只补最近 N 条,不从 0 拉全史)、`startup_backfill_max_records`(默认 5000) | `subscription.rs:132-141` |
| 补拉信号不许自动跟单 | 补拉(`mode=backfill`)信号在投递前打 `metadata.agent_pull.auto_copy_policy=review_only`,实时(`mode=live`)才是 `live_fresh_only`;跟单准入闸读这个标记 | `subscription.rs:646-679`;消费端 `console-core/src/copy.rs:1029-1042` |
| 单写者/回环规则 | bridge(远程)走系统代理,回环(投递给本机 console)永不走代理(代理会吞掉回环请求);投递地址每轮从"本进程活着的监听端口"现取,不认 argv 里写死的端口快照 | `subscription.rs:9-27, 253-260` |

### 1.2 结构化信号字段 → 内部意图

- **内部规范化 schema**(`normalize_signal`,面向"已经结构化"的信号,非 bridge 原文):字段 `signal_id/source/symbol/market/side(long|short|close)/action(open|close|reduce)/order_type(market|limit|stop_market|take_profit_market)/size{mode:fixed|quote|percent_equity|copy_ratio, value}/leverage/price/trigger_price/stop_loss/take_profit/timestamp`。`side` 接受 `buy|sell|long|short|close` 归一;`timestamp` 超过 1e10 自动判为毫秒转秒。—— `backend/crates/console-core/src/signals/schema.rs:18-115`
- **带单员原文(中文自然语言/结构化 bridge payload)→ 归一化 trade event**(`normalize_trade_event`):抽取 `coin/direction/entry_price/stop_loss/take_profit/leverage`,`action_type` 由 `detect_action` 规则判 —— `backend/crates/console-core/src/signals/parser.rs:433-505`
  - `action_type` 枚举(`normalize_action`):`open | add | reduce | close | cancel | stop_loss_update | take_profit_update | stopped_out`,其余归一为 `unknown` —— `parser.rs:100-107`
  - `detect_action` 判词优先级(从高到低):"新开仓四要素齐全"(方向+入场+止损+止盈)→`open`;"撤单/取消挂单"→`cancel`;"止盈更新/移动止盈"→`take_profit_update`;"移动止损/推保护/保本"→`stop_loss_update`;`REDUCE_HINT_RE`(平/止盈/减仓+百分比)或"减仓/止盈一半"→`reduce`;"平仓/全平"或英文 close→`close`;"加仓/补仓"→`add`;方向/入场类词→`open`;否则 `unknown` —— `parser.rs:160-186`
- **Bridge envelope → 内部字段映射**(`external.rs`):`action_from_side`(`close_long/close_short`→`close`,其余→`open`)、`direction_from_side`(`long/close_long`→`Long`,`short/close_short`→`Short`)、`trader_from_source`(`source` 形如 `xxx:交易员名` 取冒号后段)、`price_text`(有 `prices[]` 就拼接,`type=="market"` 且价空 → 文本 `"市价"`,避免被解析层误判成"缺入场价") —— `backend/crates/console-core/src/signals/external.rs:29-97`
- **多档 TP / entry zone**:`targets_text` 把多目标价用 `-` 拼接成价格串,交给同一套价格解析器(`parse_price_field`)切成多档 —— `external.rs:99-107`;下单侧的多档拆分见 §2.2。
- **size_pct / 名义 / 保证金×杠杆链**:见 §2.2「仓位计算」。
- **valid_until / 时效**:风控层 `max_signal_age_seconds`(默认 180s)按信号 `timestamp` 或 `meta.source_timestamp_seconds` 判"过期";跟单侧另有独立的 `auto_copy_freshness_seconds` 闸(见 §2.3)—— `backend/crates/console-core/src/risk.rs:198-217`

### 1.3 信号生命周期分类(决定要不要进跟单)

- `classify_external_signal_record_indexed`:先过 `ignore_reason`(噪声/无效);`action=="open"` 时若匹配到已存在的开仓信号 → 判 `duplicate_open`(或有"撤回/重发"类措辞 → `replacement_open`,即取代原单);非 open 动作一律归为 `lifecycle_status="management"`(管理类,进人工审核/半自动链路,不直接下单)—— `backend/crates/console-core/src/signals/lifecycle.rs:2129-2260`
- `MANAGEMENT_ACTIONS = [cancel, close, reduce, stop_loss_update, take_profit_update, stopped_out]`(注意 **`add` 不在这个常量里**,但因为分类函数对"非 open" 一律落到 management 分支,`add` 依然会被判成 `lifecycle_status="management"`,从而在 `maybe_auto_copy_external_signal` 里被早退跳过——这正是"加仓无自动路"的机制来源,见 §3.4)—— `lifecycle.rs:16-22`
- **R53 再入场放行**:重复开仓若被去重指向的原单入场腿已全部终态非成交(全撤/过期/被拒且未持仓),判定"原单已死",改按 `new_open` 处理,允许再入场 —— `backend/crates/console-api/src/core.rs:11577-11602`

---

## 二、开仓规则

### 2.1 入场区怎么挂

| 规则 | 口径 | 源位置 |
|---|---|---|
| 市价意图不发裸市价单 | 若信号是市价意图(无有效入场价),按"顶着滑点上限价的 IOC 限价单"下(Binance 官方跟单同款):超过滑点上限不成交直接过期,绝不追价 | `orders/adapter.rs:242-272` |
| 滑点上限 | BTC/ETH 默认 0.3%,其余默认 0.5%,可用 `risk.entry_slippage_caps.{major,default}` 覆盖 | `orders/adapter.rs:192-201` |
| 限价入场取哪个价 | `entry_price_for_side`:`short` 取入场价集合里的**最大值**,`long` 取**最小值**(即各自"更保守/更容易成交"的一侧),否则回退 `selected_price` 或首个价 | `orders/adapter.rs:66-79` |
| 止损/止盈保护价取哪个 | `protective_stop_price`:`long` 取止损候选集**最小值**,`short` 取**最大值**(离场更保守) | `orders/adapter.rs:81-91` |
| 入场区多档阶梯拆分 | `split_percents`:`profile.entry_split.percents` 显式给权重则按其归一化到 100%;未给且价位数>1 则均分(`equal_percents`);单价直接 100% | `orders/adapter.rs:93-136` |
| 入场限价距 mark 太远拒绝 | `price_near_mark`:偏离 mark 超过 `risk.max_price_deviation_percent`(默认 0.55%)直接拒 | `orders/adapter.rs:203-206` |
| 追价上限(限价单不许比 mark 更激进) | `check_limit_price_side`:多头限价不得高于 `mark×(1+max_aggressive_limit_deviation_percent)`(默认 0.05%),空头不得低于对称下界 | `orders/adapter.rs:208-241` |
| 阶梯限价单类型 | 非市价意图的每一档都是普通 `limit` 单(不追价、不轮询改价) | `orders/adapter.rs:274-297` |

### 2.2 仓位怎么算(名义链换算)

- **规范化档位**:`normalize_copytrading_profile_with_legs` 把用户输入的 `margin_usdt`(或别名 `order_margin_usdt`/`notional_usdt`)与 `leverage` 统一算出 **`notional_usdt = margin_usdt × leverage`** 并连同 `margin_usdt/leverage` 一起持久化为规范档;`leverage` 缺省 `min(3, max_leverage)`,`margin_usdt` 缺省 100 —— `backend/crates/console-core/src/copy.rs:237-263`
- **反向换算**(用户直接改 `notional_usdt` 覆盖):`profile["margin_usdt"] = notional / active_leverage` —— `copy.rs:1264-1272`
- **下单侧取用**:`preview()`(`orders/adapter.rs`)读规范档的 `notional_usdt`(缺省 100)与 `margin_usdt`(缺省 `notional/leverage`),按入场阶梯拆分算出每档 `size.value = notional_split / entry_price` 的币数;`meta.copy_notional_usdt`/`meta.copy_margin_usdt` 原样写回订单供风控/对账复用 —— `orders/adapter.rs:710-788`
- **单笔仓位上限硬闸(R63)**:开仓腿的名义价值 `entry_notional_usdt`——优先读 `meta.copy_notional_usdt`(跟单腿的精确值),否则仅当 `size.mode=="fixed"` 时按 `size.value × price` 估算,其余(quote/percent_equity/copy_ratio)不猜;账户权益读不到时放行但打标 `position_cap_skipped_equity_unreadable`,金额算不出来打标 `position_cap_unpriced`;`本单名义 ≤ 账户权益 × risk.max_position_percent`(默认 **0.5 = 50%**),超限拒单,拒单文案直接给出"本单多大/账户多大/上限多少/怎么改" —— `risk.rs:108-131, 234-283`
- **杠杆上限**:`risk.max_leverage`(默认 100)—— `risk.rs:220-231`;跟单档位另受 `config.max_leverage()` 二次封顶(`copy.rs:245`)。

### 2.3 什么情况拒开

| 情形 | 口径 | 源位置 |
|---|---|---|
| 急停 | `risk.emergency_stop=true` → 一切拒 | `risk.rs:142-144` |
| 币种/来源黑白名单 | `allowed_symbols`/`blocked_sources`/`allowed_sources` | `risk.rs:145-192` |
| 信号过期(直连路径) | `age > risk.max_signal_age_seconds`(默认 180s);跟单路径(带 `meta.source_timestamp_seconds`)改由跟单页"信号有效期"闸门裁决,不叠加两道闸 | `risk.rs:198-224` |
| 跟单新鲜度闸 | `copytrading_autocopy_guard`:`auto_copy_freshness_seconds>0` 且信号来源时间 age 超过该值 → `status=review_only`,不自动执行,只存证复盘;补拉(`agent_pull.mode=backfill`)信号除非 `allow_backfill_auto_copy=true` 否则恒 review_only | `console-core/src/copy.rs:1029-1067` |
| 杠杆超限 | `leverage > risk.max_leverage` | `risk.rs:220-231` |
| 单笔仓位超配(权益比例硬闸) | 见 §2.2 | `risk.rs:234-283` |
| 带单员没在跟单名单/该资产腿关闭 | 名册里查不到该带单员(可能是改名/名册被清空)→ 静默 skip 但打 `copy_unknown_trader:*` 告警事件;已配置但 `enabled=false` 保持安静 | `console-api/src/core.rs:12547-12561` |
| 单写者防线 | 同 symbol 存在"其它控制台"挂单指纹 → 阻断本次自动跟单,`status=blocked, category=multi_writer` | `core.rs:12780-12796` |
| 反向敞口防线(R55) | 单向持仓模式下,反向开仓等于平别人的仓 → `reverse_exposure_guard` 拦截(只拦开仓/加仓类动作) | `core.rs:12800-12822` |
| 重复开仓 | 同一原始信号短时间内重复 → `duplicate_open`(去重指向已有信号,不重复下单),除非原单已全终态死亡(R53 再入场) | `lifecycle.rs:2161-2189`;`core.rs:11577-11602` |
| 管理类动作不走开仓路径 | `add/reduce/close/stop_loss_update/take_profit_update/cancel/stopped_out` 一律判 `lifecycle_status=management`,`maybe_auto_copy_external_signal` 直接早退返回 `status=skipped` | `core.rs:12472-12500` |
| 无止损默认拒 | `allow_missing_protection` 默认 `false`,信号没给止损时默认不开仓(适配器判 `NO_STOP_LOSS`);打开该项后这类仓天生无保护腿,补挂引擎也不会凭空发明止损意图 | `copy.rs:233-240` |

---

## 三、持仓管理

### 3.1 止损止盈腿怎么挂与核验

- 保护腿覆盖分类是**纯函数**,事实源是**交易所挂单行**而非本地订单状态(本地 `submitted/NEW` 可能已被手撤或已触发离场)—— `backend/crates/console-core/src/protection.rs:1-5`
- `classify_coverage(position_qty, legs, step)`:按仓位量与挂单覆盖量的差值分类(是否覆盖不足/精确/超配)—— `protection.rs:128-183`
- SL/TP 类型识别:`SL_TYPES=[STOP, STOP_MARKET]`,`TP_TYPES=[TAKE_PROFIT, TAKE_PROFIT_MARKET]` —— `protection.rs:12-13`
- 分批止损(`stop_loss_split`)：多档 `stop_market`,各档相对信号止损价向入场方向收紧的偏移(百分比),`offsets_pct` 与 `percents` 等长,0=原止损价,正数=更靠近入场价(更早触发);**默认关闭**(单一止损),需显式开启才分批 —— `console-core/src/copy.rs:69-115`
- 多档止盈权重重映射:`remap_tp_weights` —— `shadow.rs:259`(回放侧同口径复用)

### 3.2 带单员 reduce/close/改损 怎么跟

- **默认全部人工审核**:`order_management.auto_apply.*` 默认值 `reduce=false, stop_loss=false, take_profit=false, cancel_entries=true`(只收回入场挂单是唯一默认开的自动动作);`freshness_seconds` 默认 300s,超龄信号一律只进人工列表 —— `signals/management.rs:894-908`
- **"移动止损到保本"专项解析**(`plan_suggested_stop_price`):区分 `absolute`(建议里直接给的数值)与 `cost`(保本/回本类相对口径,需要换算成"目标仓的入场成本",由调用方按本策略成交重放算出,**不是交易所净仓均价**);带单员自己的入场价(`entry_reference`)只在实在没有别的数时才降级使用,且必须打标 `foreign_entry` 供执行侧拒绝自动执行 —— `signals/management.rs:754-865`
- 8794 生产上"移动止损到保本"是**最高频**的一类管理信号(代码注释原话)—— `management.rs:735`
- 保本关键词表(`COST_BASIS_TOKENS`):`breakeven/break_even/break even/entry/cost/保本/成本/入场/开仓价/回本/回到本` —— `management.rs:741-747`
- 带单员喊撤/平且入场未全成交 → 自动撤线程在场的入场挂单(`trader_retracted_entries`,减敞口动作,默认开,不受 `auto_apply_gate` 消费)—— `management.rs:895-897`

### 3.3 "平仓没跟上"怎么补(带单员出场离场硬门,原型即用户说的"SPCX 离场硬门")

`reconcile_trader_exits`(每轮对账):带单员终态信号(`closed/cancelled/stopped_out`)到达且过了宽限期(`risk.trader_exit_grace_minutes`,默认 10 分钟),但线程认领仓位仍在(价格没踩到本地 SL/TP)——

- 处置模式 `risk.trader_exit_action`:`alert`(只告警,30 分钟限流)/ `market_close`(**默认**,市价平掉线程认领量)/ `off` —— `core.rs:4990-5001`
- **条件出场(用户自己挂的"到价才出局")不算带单员已出场**:识别信号 `conditional_exit` 标记并排除,避免宽限期后误市价平仓 —— `core.rs:5063-5069`
- **市价离场硬门**(必须同时满足才动手,任一不满足只告警不动手):
  1. 独占归属:`claim_proves_sole_ownership(position_qty, claimed_qty, unattributed_qty, claim_narrowed, sole_claimer, step)`——认领量收窄后仅剩本线程、且账面无未归属净仓、仓位量 ≤ 认领量(容差=一个 lot step) —— `protection.rs:184-197`
  2. **两条归属通路都要过**(2026-09-03 SPCX 实锤逼出来的规则):(a) 认领口径(claimed_qty 收窄,若 unclaimed 未归零则退回 (b));(b) 旧口径 `thread_entry_ownership_excluding` 扫全量订单,但排除**已结案线程**的历史成交,否则会被三周前已 `manual_ack` 结案的另一条线程的 FILLED 入场单永久判"独占归属=false"——原文实锤见 `core.rs:5155-5163`
  3. 认领口径必须是 `ledger_exact`(`confidence != "ledger_exact"` 直接不通过)
  4. 实仓在场(`available > 0`)
  - 平仓量 = `min(认领量, 可证明量, 实仓量)`;门未过只发 `position.trader_exited_alert`(结构化打出 `独占归属/可证明量/实仓/认领口径/认领证明` 四个判据),绝不擅自动手 —— `core.rs:5040-5250`
  - 幂等标记(kv `trader_exit_done:{strategy_id}`)防 90s 循环重复下单;**30 分钟仍未见效**(ACK 后异步失败/进程崩溃)自动重挂并告警(评审 AR-06)—— `core.rs:5103-5121`
  - 引擎模式(one-way/hedge)不确定期间冻结,宁可不动也不发错方向的市价单 —— `core.rs:5013-5016`

### 3.4 加仓(add)无自动路的现状

- `AutoApplyConfig` 结构体只有 `reduce/stop_loss/take_profit/cancel_entries` 四个开关字段,**没有 `add`**——加仓永远不在"自动执行"闸门的可选项里 —— `signals/management.rs:880-897`
- `add` 动作在生命周期分类里落入非 open 分支,判 `lifecycle_status="management"`,`maybe_auto_copy_external_signal` 在早退检查(`lifecycle_status ∈ {duplicate,management,cancelled,closed,superseded,ignored,stopped_out}`)时直接 `status=skipped, reason="order lifecycle event: add"` —— `core.rs:12472-12500`;`lifecycle.rs:2161-2260`
- 结论:加仓信号目前**只进管理计划(人工审核台账)**,没有像开仓一样的自动下单执行路径;代码里出现的 `matches!(action, "open"|"add")` 判断(如 `core.rs:3169, 3556, 3780, 12804`)是防御性/共用逻辑,不代表 add 真的能走到那一步。

### 3.5 保本移动

见 §3.2 的 `cost` 口径解析;执行侧(自动应用闸门 `stop_loss=true` 时)按换算出的目标价挂 `stop_loss_update`,来源标记 `foreign_entry` 的计划不允许自动执行(只能人工确认)。

---

## 四、异常处理

### 4.1 孤儿仓 / 孤儿单

- `strat.orphan=true` 的线程在几乎所有自动动作(超配收敛、离场硬门、归属认领候选、条件出场、多写者判定等)里被统一排除,只提醒不自动动手 —— `core.rs:4426-4427, 4891, 5048, 7953, 8314`(共 20+ 处引用)
- 归段改动:老单落在 `[段起点, 下一段起点)` 才收,归不上进 orphan,不再倒进最新段(R59 已上线修复)—— `docs/r59-overcoverage-resize-residuals.md` §一
- 500 条事件窗外的旧单进 orphan、活仓只告警不自动补保护,是已知降级,依赖工作台 `orphan_unresolved_count` 指标有人盯 —— 同上文档 §四

### 4.2 超配收敛(OVERCOVERAGE_RESIZE_ENABLED)

- **撤腿(trim)总闸**:`overcoverage_trim_allowed(mode)`——one-way 恒放行;hedge 受 `HEDGE_OVERCOVERAGE_TRIM_ENABLED=true`(2026 年已解除硬停用,实证③在 demo-fapi 证明"超量 reduceOnly 腿触发时最坏只是整单被拒、不会打穿到反向")—— `protection.rs:16-58`
- **plan_overcoverage_trim 规则**(纯函数,输入=已确认全部归属本台的同向 SL 腿):完全重复腿(同触发价+数量+closePosition)优先撤,保留 orderId 最小的;其后按触发价从最远撤起;同触发价先撤**数量大**的(R59 修复,否则会把"尺寸正确的新腿"错撤、留下超配的旧腿);任何一撤都不得让剩余覆盖 < 仓位(不放 lot 容差);撤不动时保留最小超配,绝不撤穿仓位 —— `protection.rs:210-343`
- **缩量换腿(resize)** 是"第二步":`plan_overcoverage_resize` 规划器**照常跑**(纯函数,算出该缩到多少,喂 `protection.overcovered` 告警的 `suggested_resize`),但**自动执行(`resize_overcovered_sl`)已写出但被总闸 `OVERCOVERAGE_RESIZE_ENABLED=false` 封存**,不真正执行 —— `protection.rs:34-54`;`core.rs:9295-9303`
- **为什么默认关**:换腿必然有"新腿已挂、旧腿未撤"的中间态,场上没有原子替换(`replace_algo_order` 本身是先撤后发);"复读仓位确认没变→撤旧腿"之间隔着一次 `open_orders` 往返+撤单授权,窗口内的加仓/外部成交发现不了,会把覆盖撤穿。三轮 Codex 复审分别挑出 8/5 条确认缺陷,详见 §六"未修坑"清单 —— `protection.rs:31-53`;`docs/r59-overcoverage-resize-residuals.md`

### 4.3 误撤单防护

- `cancel_target_authorized(local_order, remote_row, sim_mode)`:仿真模式直接放行;真实模式**必须**本地记录的 `exchange_order_id` 与远端刷新后拿到的 `orderId` 精确相等才允许撤单,任一为空或不等一律拒绝——防止"classify=='mine' 只是启发式身份"被误当撤单授权(复审二轮 B3 结论)—— `core.rs:5287-5295`;调用点见 `core.rs:4772, 4925, 6637, 6719, 9147-9170, 9854, 19282`
- R65-F1 可观测性:入场单"被撤"远多于"成交"是"自动清理误撤"这类静默事故唯一的观测线索,比例失衡时打事件 —— `core.rs:4429-4452`

### 4.4 凭证/时钟问题

- **Binance 服务器时钟偏移**:进程共享一个时钟偏移状态,惰性刷新(`sync_server_time`),用请求发送/接收时刻的中点减半 RTT 估计偏移,足以覆盖"本机时钟比服务器快几百毫秒"的场景;`-1021`(时间戳异常)错误会强制立刻重新同步 —— `backend/crates/console-core/src/exchanges/binance.rs:1337-1385`
- 公开端点(`/fapi/v1/time`)服务器时间探测同时用于"凭证诊断的链路连通性步骤",顺带算本机与交易所时钟偏差(偏差 > recvWindow 会导致签名请求全挂)—— `binance.rs:1786-1787`
- `recvWindow` 默认 60000ms —— 见 `AGENTS.md`/`binance.rs` 中 `recv_window` 字段(config 侧)。

### 4.5 段键与归属(派生式归属兜底)

- **段键漂移兜底**(R66):重分段后查不到自己结论的段,退到"线程根 + 结论时刻落在本段时间跨度内"把孤儿结论认回来;精确命中的段不受影响(派生只填空位)。不做这一步,已定罪的线程每次重分段都会重新变成"无结论",反复重新取证并让"已定罪线程不得认领净仓"失效 —— `core.rs:18915-18923`
- 实现:`derive_drifted_exit_resolutions(strategies, resolutions)`——只处理段键已不在场(`live_ids` 不含)的历史结论;只认"带真实成交流水时刻"的结论(`migratable_boundary_ms`)才有资格换段;按 `(结论时刻, -取证时刻, 源键)` 升序取第一名 —— `console-core/src/strategy.rs:1501-1541`起
- 归属证明两条通路(超配收敛/离场硬门/加仓认领共用同一套):(a) 认领口径 `claimed_qty` 收窄后唯一非孤儿在场线程,认领量盖住净仓且无未归属净仓;(b) 旧口径 `thread_entry_ownership_excluding` 扫全量订单,排除已结案线程;`claim_proves_sole_ownership` 是判据的纯函数实现 —— `protection.rs:184-197`;`core.rs:8012-8090, 8315-8440`

---

## 五、带单员评估(影子回放引擎)

### 5.1 引擎语义演进(v8 → v9 → v10 → 当前 v11)

- 当前引擎版本常量 `REPLAY_ENGINE_VERSION = 11` —— `backend/crates/console-core/src/shadow.rs:54`
- **v8→v9(2026-08-15,§101)**:修复"跳空成交价"——旧引擎把 stop/TP/limit 的**触发价**直接当成交价,即使当根 K 线 open 已跳过该价、整根 `[low,high]` 都够不到,仍按目标价记账。v9 统一三条规则:stop 跳空按更差 open 记账、TP/limit 跳空按更优 open、limit/zone 入场与加仓跳空按更优 open;未跳空仍按 stop/target/limit 原价。同时修了"分段 opener 命名漂移"(同毫秒多事件排序不稳定导致段首身份不同)—— `docs/v2-session-handoff.md` §101(约 2660-2710 行)
- **v9→v10(2026-08-16)**:叙事审计抓到"rolled 结局失真"——带单员明确喊了止盈/平仓/出局,引擎却因 `management_target_signal_id` 指向别的段而把 close 当 roll 边界结转;修复两条语义:段内 close/stopped_out 只要方向与本段一致即按 `signal_close` 整仓结算(不再当 roll 边界);反向 close/stopped_out 对本段既不结算也不构成 roll 边界(直接忽略)—— `docs/v2-session-handoff.md`(约 2860-2900 行);`shadow.rs::close_event_conflicts_segment`(`shadow.rs:1040`)
- **v10→v11**:见 `docs/narrative-audit-runbook.md` §"v10 落地后" 及后续轮次,变更点未在本次调研中逐条复核,建议移植前单独查 `REPLAY_ENGINE_VERSION` 历史 diff。

### 5.2 指标口径(HTTP 暴露字段)

- 核心聚合函数 `aggregate_trader_stats(source, replays)`(纯函数,输入=某带单员全部影子回放行)—— `core.rs:1035-1230`
  - **胜率** `win_rate` = 已结算(`resolved`,出场原因 ∈ `tp/sl/signal_close/flipped/rolled/breakeven/max_favorable`)里 `pnl_pct>0` 的占比;**数据不完整(`data_status != complete`)的行不进任何分母** —— `core.rs:1038-1063`
  - **期望值** `expectancy_r`/`avg_r` = 逐笔 `r_multiple` 均值
  - **盈亏比** `profit_factor` = 未封顶毛盈利 / 未封顶毛亏损绝对值(`uncapped_pnl_pct` 优先,避免账户层"亏光封顶"污染逐笔指标)
  - **回撤** `max_drawdown_pct` = 复利净值曲线(本金 1.0,每笔 ×(1+pnl%)）的峰谷跌幅,与"逐笔过程"的 `avg_mfe_pct/avg_mae_pct`(价格口径,不含杠杆)是两个世界观,注释里特别强调"别混着读"
  - **收益曲线** `equity_curve_r`(累计 R)与 `equity_curve_pct`(复利收益率 ‰),均按**出场(结算)时间**排序,不是入场时间
  - **成交率** `fill_rate` = (可判定信号 − no_fill) / 可判定信号,`awaiting_fill` 与最后一段 `open` 不进分母
  - **频次** `freq_per_week`、**平均持仓** `avg_hold_seconds`、**爆仓次数** `liquidations`+`first_liquidation_index`
  - **没有"夏普比率"字段**——全仓库 `grep -i sharpe` 零命中,8794 目前不算 Sharpe。
- **杠杆化包装** `stats_with_leverage`(在 `aggregate_trader_stats` 上叠加 `avg_leverage`/`avg_effective_leverage`,以及 `exit_mode_effective`/`remainder_mode_effective` 的"mixed"标注)—— `core.rs:604-650`

### 5.3 对外 HTTP 端点

| 端点 | 参数 | 返回要点 | 源位置 |
|---|---|---|---|
| `GET /api/leaderboard` | `window=7d\|30d\|90d\|all`(默认 all)、`sort=return\|winrate\|expectancy\|drawdown\|profit_factor\|fill_rate\|freq\|hold`、`order=asc\|desc`、`exit_mode=trader\|custom`(默认 trader,按带单员喊单 TP/SL 结算 vs 按用户自己跟单设置分批结算)、`remainder_mode`(默认 market)、经济口径透传参数(`ReplayEconomics::QUERY_KEYS`,如杠杆模式/费率/资金费) | 按带单员聚合的 `aggregate_trader_stats`+`legs`(crypto/tradfi 分腿)+`ranked`(已结算≥5 笔才算入排名);"假设全额跟单的历史重放,非实盘战绩"需 UI 标注 | `console-api/src/lib.rs:1580-1598`;`core.rs:16054, 16144-16260` |
| `GET /api/leaderboard/{source}/detail` | `window/exit_mode/remainder_mode`+经济口径 | 单个带单员的明细(含 `equity_curve`) | `lib.rs:1605-1623` |
| `GET /api/copytrading/trader-stats` | 无 | 与 leaderboard 同口径的按带单员聚合(`by_source`) | `lib.rs:1556-1558`;`core.rs:16040-16051` |
| `GET /api/copytrading/trader-stats/{source}/replays` | `source`(路径) | 该带单员逐笔影子回放行 | `lib.rs:1628` |
| `GET /api/reconciliation` | 无查询参数(刻意钉死在跟单配置口径,不接受显示口径覆盖) | 实盘成交 vs 影子回放的逐笔对账(Gate C),`order_scan.{ok,returned}` 标注订单快照是否读全 | `lib.rs:1571-1575`;`core.rs:16058-16143` |
| `POST /api/v1/external/signals` | body=bridge envelope | 跟单信号入口(见 §1) | `core.rs:11553` 起 |

鉴权:上述端点全部走统一中间件 `auth_middleware`——`console.auth_token` 为空(本机默认)则按 Host/Origin 校验放行(role=Open);配了 token 则按 `X-Auth-Token`/`Authorization: Bearer` 校验(role=Full/ReadOnly/Proposal 四级);见 `lib.rs:314-560`(未在本次任务中逐行复核,§7 的 8794-feature-inventory.md 已有更细粒度记录)。

### 5.4 本机 8794 的实际运行地址与鉴权(2026-09-12 现查)

- 进程:`console-api --root ~/Desktop/trade-switch-dev-hedge --port 8794`(pid 33556)
- `console_url = http://127.0.0.1:8794`,`console_instance_id = aca6fefc-f86d-4a44-93e2-ba8beec455b3`(`data/console-runtime.json`)
- `bridge_url = https://<bridge-domain>`(`data/console_agent_launch.json`,console-agent 订阅目标)
- `GET /api/health` → `{"mode":"live","features":{"auth_required":false,"lead_trading":false},"setup_completed":true}`;`GET /api/auth/whoami` → `{"role":"open"}` —— 即本机当前**未配置 `console.auth_token`**,走 Host/Origin 本机校验,没有 Bearer token 门槛。
- 订阅状态(`data/console_agent_status.json`,现查):`console_url` 与游标 `after_id`/`last_record_id` 均可实时读到,`wait_seconds=10, mode=live`。

---

## 六、参考文档(backend 相关的跟单文档路径)

- `AGENTS.md`(根目录):红线三条——单写者原则(同账户只允许一台控制台写,`risk.protection_guard` 等引擎类开关同理)、生产数据目录只读、主网 key 不进 agent 可读配置;权威上下文指向 `docs/v2-session-handoff.md`。
- `docs/v2-session-handoff.md`(3282 行,按 § 编号的全部轮次记录):§101 影子回放 v9 跳空成交价修复;v10 落地(rolled 结局失真修复)等章节与跟单/回放引擎强相关。
- `docs/r59-overcoverage-resize-residuals.md`:R59 超配止损缩量换腿的封存说明与残留缺陷清单(§六"未修坑"直接取自这里)。
- `docs/r58-evidence/03-two-legs-coexistence.md`:超配 reduceOnly 腿触发时行为的交易所实证(HEDGE_OVERCOVERAGE_TRIM_ENABLED 解封的依据)。
- `docs/narrative-audit-runbook.md`:叙事审计基线报告,v10 引擎修复的源头(rolled 结局失真)。
- `docs/audit-remediation-plan.md`、`docs/handoff-2026-08-22.md`、`docs/HANDOFF.md`:历史审计整改追踪,未逐条复核但含跟单相关遗留项。
- `docs/design-r46-exit-evidence-timeout-matrix.md`:出场证据超时矩阵设计(离场硬门相关设计背景,未在本次任务中细读,建议移植前单读)。
- `docs/design-r54-position-authoritative-state.md` / `docs/audit-r54-position-authoritative-state.md`:仓位权威状态设计与审计。
- `docs/design-r45-net-position-attribution.md`:净仓归属设计(段键与归属兜底的设计源头)。
- 已存在的同类调研:`~/Desktop/trading-swarm/docs/research/8794-feature-inventory.md`(功能面盘点,偏 HTTP API/状态机/前端;本文件聚焦跟单规则细节,两者互补)。

---

## 七、移植到 trading-swarm 时最该保留的 10 条

1. **管理动作与开仓动作物理分离**:`MANAGEMENT_ACTIONS`(cancel/close/reduce/stop_loss_update/take_profit_update/stopped_out)+ `add` 一律先落地为"管理计划"（人工审核台账），只有 `open` 才能触发自动下单——这是"加仓/减仓/改损默认全人工"这条纪律的底层机制,建议原样搬,不要图省事把 add 也接自动执行(§3.4、§2.3)。
2. **市价意图 = IOC 限价 + 滑点上限**,绝不发裸市价单、绝不追价(§2.1)。
3. **单笔仓位上限按"名义 ÷ 账户权益"算**,而不是只挡 `size.mode=="percent_equity"` 这一种输入——R63 明确记录过"填 1% 还是 100% 照样下出去"的真实事故,这条闸必须对所有开仓腿生效(§2.2)。
4. **名义换算链** `notional_usdt = margin_usdt × leverage`,双向都要能换(用户填保证金或填名义都行),且这条链要在跟单档位规范化时就钉死,不要散落在下单那一刻现算(§2.2)。
5. **止损"保本/回本"口径必须按本策略自己的成交重放算成本,不能用带单员的入场价、也不能用交易所净仓均价**——多条策略/多次加仓共享同一净仓时,均价不是"这一仓"的成本(§3.2)。
6. **带单员出场但本地仓位没跟上时的"市价离场硬门"**——独占归属(两条通路都要过)+ 认领口径精确(ledger_exact)+ 实仓在场,四个判据必须结构化打进告警文案,任一不满足只告警不动手;这条是从真实事故(SPCX)反推出来的最小充分条件,建议整体搬(§3.3)。
7. **撤单前必须精确比对本地 `exchange_order_id` 与远端刷新后的 `orderId`**,启发式身份(classify=="mine")不能当撤单授权(§4.3)。
8. **超配收敛"能撤腿、不能缩量换腿"的边界**:撤腿有安全论证(交易所实证:超量 reduceOnly 触发最坏整单拒、不会打穿到反向),缩量换腿有结构性 TOCTOU(没有原子替换),两者不能一刀切开或关(§4.2)。
9. **段键漂移要有派生式兜底**,否则重分段会让已经人工结案的线程反复"复活"成待处理,持续误报(§4.5)。
10. **补拉(backfill)信号默认只许复盘、不许自动跟单**,靠信号元数据(`agent_pull.mode`/`auto_copy_policy`)在**投递那一刻**就打好标记,而不是让消费端猜"这条是不是刚补回来的"（§1.1）。

## 八、8794 自己都还没修好的坑

来源主要是 `docs/r59-overcoverage-resize-residuals.md`(超配缩量换腿封存清单)与代码内长注释,按严重度摘录:

- **critical**:数量门残余 TOCTOU——复读仓位之后、撤旧腿之前还有一次 `open_orders` 往返+撤单授权,窗口内的加仓不会被发现;这是"缩量换腿"总闸(`OVERCOVERAGE_RESIZE_ENABLED`)默认关闭的根本原因,官方结论是"这个 TOCTOU 加再多重读也关不上",**目前没有已知修法**,只提出一个未经论证的方向("接受撤旧腿后短暂覆盖不足,靠补挂引擎下一轮补回来")。
- **high**:
  - 缩量执行器的 attempt 计数只增不减且无退避/上限,持续失败会把订单表写到 1000 行触发 `orders_truncated`,导致**整个归一化引擎永久停手**(不是局部降级,是全局停摆)。
  - 首次提交返回 `unknown_after_send` 被误判为失败,错误推进重试计数。
  - `new_live == false` 时直接返回 true(不回滚、不告警),本地行停在 `submitted`,要等十分钟对账才会发现"静默卡死"。
- **medium**:STOP 限价腿撤换时没继承 `timeInForce`(IOC/FOK/GTX 会被默默改成 GTC);`protection.resize_skipped`/`resize_rolled_back` 未限流,持续超配时约 40 条/小时/仓位刷屏。
- **low/存疑**:数量门用固定 `1e-9` 绝对阈值,与品种 step size 无关,step 较大的品种会漏掉一整个 lot;`trimmed_any` 只代表"规划过撤单"不代表"撤成功",可能饿死本可行的 resize(需故障注入才能证实/证伪)。
- **前置缺口**:缩量执行器本身**零自动化测试**,三稿实现全靠人读+复审,没有故障注入覆盖(提交失败/撤单失败/窗口内加仓/多写者置位)。
- **实证空白**:`docs/r58-evidence/03-two-legs-coexistence.md` 的结论段仍是占位符(`〔…〕`)没人填过——超配 reduceOnly 腿"0 < 仓位 < 腿量"时触发的真实行为(07-14 事故是被削量成交,不是整单拒)仍无定论,两种结果都等于"该平的仓没平掉"。
- **引擎版本历史未逐条复核**:v9→v10→v11 的变更点本次只核实了 v8→v9、v9→v10 两段(§5.1),v10→v11 的具体修了什么在本次任务时间预算内未展开,移植前建议单独查 `REPLAY_ENGINE_VERSION` 相关 handoff 章节。
