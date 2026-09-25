# 接口说明书:Signal Bridge 订阅协议 + 8794 带单员统计(给 trading-swarm 接入用)

2026-09-12 · 只读调研,medium 强度。目标:给 trading-swarm(TypeScript 网关)接入两个外部数据源
——Signal Bridge 的订阅者拉取协议、8794 console 的带单员统计/回放接口——提供足够精确的接口
说明,以及 trading-swarm 内部数据模型的映射建议。全文来自源码调研,未修改任何仓库。

调研范围:
- `~/Desktop/trade-switch-v2/signal-bridge`(FastAPI,Signal Bridge)
- `~/Desktop/trade-switch-rs`(Rust,console-api,本机 8794 实例是 `trade-switch-dev-hedge`)
- `~/Desktop/strategy-public-api`(FastAPI,对外只读策略统计 API,数据源即 8794)

---

## A. Signal Bridge 订阅者拉取协议

### A.0 现成文档(已存在,直接可用)

Signal Bridge 仓库里已经有面向订阅者的接入文档,trading-swarm 接入时应优先参照这两份,而不是重新摸索:

- `~/Desktop/trade-switch-v2/signal-bridge/README.md`
  - `## Subscriber Fan-Out API`(第 144 行起):列出全部 subscriber 端点、鉴权头、Agent Pull 建流程。
  - `## Subscriber Pull Mode`(第 187 行起):推荐模式(bridge 主动推不可达时用轮询拉取),给出
    `config/console_agent.json` 的完整字段示例(`bridge_url` / `api_key` / `secret_token` /
    `console_url` / `console_ingest_token` / `interval_seconds` / `wait_seconds` /
    `bridge_poll_interval_seconds` / `request_timeout_seconds` / `reconnect_delay_seconds` /
    `agent_id`)。
- `~/Desktop/trade-switch-v2/signal-bridge/BRIDGE_ADMIN_SETUP.md`
  - `## Subscriber API`(第 218 行起):同一份端点列表 + `POST /api/v1/admin/subscribers/{id}/keys`
    (管理员侧签发 key 的端点)+ 权限边界说明("The subscriber token can only manage its own
    Console targets, read allowed signals, and record its own agent deliveries. It cannot change
    Lark, parser, Bridge admin settings, or other subscribers.")。

trading-swarm 直接照抄这两份文档里的 Agent Pull 流程即可;下面补充源码级别的字段细节(文档里没写全的
部分),供实现时对照。

### A.1 路由与鉴权

路由前缀:`/api/v1/subscriber`(定义于 `app/routers/subscribers.py`,挂载于 `app/main.py`)。

鉴权头(两个都必须带,`FastAPI Header` 强制):

```
X-API-Key: sbk_<token_urlsafe>
X-Secret-Token: sbs_<token_urlsafe>
```

签发逻辑见 `app/services/subscription_service.py:147`:

```python
api_key = f"sbk_{secrets.token_urlsafe(24)}"
secret  = f"sbs_{secrets.token_urlsafe(32)}"
```

注:用户提到的 `sbk_u_…` 形式不是当前代码实际生成的格式——实际就是 `sbk_` + `secrets.token_urlsafe(24)`
的原始输出(`token_urlsafe` 用的是 URL-safe base64 字符集,里面可能随机出现下划线,不代表存在
固定的 `u_` 中缀)。接入时按“`sbk_` 前缀 + 任意 URL-safe 字符串”做校验,不要硬编码 `sbk_u_` 这个形状。

`secret_token` 只在签发那一刻返回一次,服务端只存 `hash_secret()`(sha256)+ `secret_preview`,库里
查不到明文,丢了必须重新生成。

认证成功后返回的是**这把 key**(`SubscriberApiKey` 记录),不仅是 subscriber——权限(scope)挂在
凭据上而不是订阅者身上,见 `authenticate_subscriber_key`(`subscription_service.py:177`)。

Scope:

```python
SUBSCRIBER_SCOPES = ("signals", "ops")
DEFAULT_SUBSCRIBER_SCOPES = ("signals",)
```

- `signals`(默认,老 key 未标注 scope 时按此处理):拉信号、管理自己的 console target、回执。
- `ops`:额外解锁 `GET /api/v1/subscriber/ops-status`(桥的故障面:上游存活、解析积压、自己这一路
  游标落后多少、最近告警)——普通订阅者不该看到,trading-swarm 一般不需要这个 scope。

### A.2 端点清单(`app/routers/subscribers.py`)

| 方法 | 路径 | 用途 | 关键参数 |
|---|---|---|---|
| GET | `/api/v1/subscriber/me` | 订阅者自身信息 + 全库游标水位 | `recent`(0~5000,新装机时按"最近 N 条"起步游标) |
| GET | `/api/v1/subscriber/targets` | 列出自己的 Console 推送目标(Direct Push 模式用) | — |
| POST | `/api/v1/subscriber/targets` | 新增一个 Console 推送目标 | body: `name` `base_url` `ingest_token` `status` `enabled` |
| PATCH | `/api/v1/subscriber/targets/{target_id}` | 更新推送目标 | 同上,部分字段 |
| GET | `/api/v1/subscriber/signals` | **核心拉取端点**,见下 A.3 | 见下 |
| POST | `/api/v1/subscriber/agent-deliveries` | 单条投递回执(ack) | body: `signal_id` `agent_id` `status` `status_code` `response_body` `error_message` |
| POST | `/api/v1/subscriber/agent-deliveries/batch` | 批量回执(≤500 条/批) | body: `{"deliveries": [...]}` |
| GET | `/api/v1/subscriber/push-attempts` | 查自己的 Direct Push 推送记录 | `limit`(≤200) |
| GET | `/api/v1/subscriber/ops-status` | 桥故障面(需 `ops` scope) | — |

### A.3 拉取端点细节:`GET /api/v1/subscriber/signals`

这是 trading-swarm 要用的主端点(Agent Pull 模式,推荐;见 A.0 里 README 的 `## Subscriber Pull Mode`)。

查询参数(`subscribers.py:190-199`):

| 参数 | 类型/范围 | 说明 |
|---|---|---|
| `after_id` | int, ≥0, 默认 0 | **游标**——只返回 `record_id > after_id` 的信号(排他,不含边界)。这不是全局自增 ID 的简单算术起点,是订阅者可见口径下的排他游标,见下方"新装机起步"说明。 |
| `limit` | int, 1~200, 默认 50 | 一次最多返回多少条**符合本订阅者过滤条件**的信号(不是扫描条数)。 |
| `scan_limit` | int, 1~1000, 默认 500 | 一次最多扫描多少条底层记录(含被过滤掉的);扫描到顶且还没凑够 `limit` 条就提前截断返回。 |
| `wait_seconds` | float, 0~30, 默认 0 | **长轮询**:>0 时,若本次没有新信号,服务端会在这个超时窗口内轮询等待新信号出现再返回(避免高频空轮询)。 |
| `poll_interval_seconds` | float, 0.1~5, 默认 0.5 | 长轮询内部的检查间隔。 |
| `agent_id` | str, ≤120, 默认 `console-agent` | 上报到 `SubscriberAgentProgress` 用于游标观测(生产库里出过 agent 卡死 7 天而所有健康检查全绿的事故,见代码注释)。 |
| `instance_id` | str, ≤120 | 同上,区分同一 agent 的多个运行实例。 |

无需分页(page/offset 概念),按**游标增量拉取**:每次把响应里最后一条 `record_id`(或
`scanned_to_id`)作为下次请求的 `after_id`。**注意**:`scanned_to_id` 可能大于最后一条 `items`
里的 `record_id`(因为过滤掉了不属于本订阅者的信号),下次请求必须用 `scanned_to_id` 而不是
`items[-1].record_id` 做下一轮 `after_id`,否则会重复扫描同一段。

**新装机起步游标**:调 `GET /me?recent=N`,响应里的 `recent_after_id` 就是"从现在往前数满 N 条
可见信号"的安全起点(按订阅者自己的 symbol/trader 白名单过滤后计算,不是全库 ID 算术,详见
`subscribers.py:161` `_recent_after_id` 的注释——带过滤的订阅者其可见信号可能都在很早的 ID 段,
拿全库 max-N 做算术会永久漏掉本该收到的历史)。

响应形状:

```jsonc
{
  "ok": true,
  "after_id": 0,
  "scanned_to_id": 1204,      // 下一轮请求要用的游标(见上,不等同最后一条 record_id)
  "count": 3,
  "items": [
    {
      "record_id": 1198,
      "signal_id": "sig_xxx",
      "created_at": "2026-09-12T08:00:00+00:00",
      "envelope": {
        "event_type": "structured_signal.created",
        "event_id": "evt_agent_<uuid4hex>",
        "producer": "<settings.producer>:subscriber-pull",
        "schema_version": "<settings.schema_version>",
        "payload": { /* StructuredSignalResponse,见 A.4 */ }
      }
    }
  ],
  "skipped_count": 0,          // 逐条容错:一条坏行(如老校验器写入、新校验器读取失败)不会打掉整批
  "skipped": [ { "record_id": 1197, "signal_id": "sig_yyy", "error": "ValidationError: ..." } ],
  "waited": false
}
```

`skipped` 非空必须被上层观测(它是"数据需要人工看"的信号,历史上出过一条坏行导致下游 3.5 小时
断流、而 health/active 全绿的事故)。

### A.4 `StructuredSignal` 字段(`app/schemas.py`)

`envelope.payload` 就是一个 `StructuredSignalResponse`(继承自 `StructuredSignal`,额外带
`id` `raw_event_id` `parser_version` `status` `console_response` `created_at` `updated_at`)。
核心字段(`StructuredSignal`,`schemas.py:87` 起):

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema_version` | str | — |
| `parser_version` | str \| null | — |
| `signal_id` | str, 1~128 | 全局唯一 |
| `source` | str, 1~80 | 传输源(如 `telegram`/`lark`),normalize 为小写 |
| `source_message_id` | str \| null | — |
| `symbol` | str, 1~40 | normalize 为大写 |
| `market_type` | `"spot" \| "perpetual" \| "futures"`,默认 `perpetual` | — |
| `side` | `"long" \| "short" \| "close_long" \| "close_short"` | — |
| `entry` | `dict` | 自由结构;常见形状为 `{"type": "market"/"limit", "price": number}` 或 `{"type": ..., "prices": [number, ...]}`(区间/多档入场取均值供体检用,见 `_extract_price`) |
| `trigger` | `dict \| null` | — |
| `stop_loss` | `dict \| null` | 结构同 `entry` 家族,常见 `{"price": number}` |
| `take_profit` | `list[dict] \| null` | 每项形状自由,常见含 `price`(可选 `pct`) |
| `risk_hint` | `dict \| null` | — |
| `valid_until` | datetime \| null | 信号失效时间 |
| `confidence` | float, 0~1 | — |
| `metadata` | `dict`(别名 `signal_metadata`) | 见下 |

`metadata` 里 trading-swarm 关心的关键字段(来自 `app/services/ai_client.py` 的解析 schema,
字段名固定,值语义见注释):

| metadata 字段 | 取值 | 说明 |
|---|---|---|
| `trader` | str | 带单员名称 |
| `action_type` | `open \| add \| reduce \| close \| stop_loss_update \| take_profit_update \| stopped_out \| analysis_only \| unknown \| cancel` | — |
| `target_order_ref` | str(可空串) | 原文对"哪一单"的引用(如"昨天那单") |
| `order_end_state` | `not_ended \| partially_reduced \| closed \| cancelled \| stopped_out` | 与 `action_type` 联动(见下方口径表) |
| `rationale` | str | 解析理由/依据(便于人工复核) |

`action_type` ↔ `order_end_state` ↔ `ends_active_order` 口径对照(`ai_client.py:196-204`):

- `open`/`add`(新开/加仓/移动止损止盈但不结束):`order_end_state=not_ended`,不结束订单。
- `reduce`(部分止盈/减仓但仍持仓):`order_end_state=partially_reduced`,不结束订单。
- `close`(全平/清仓):`order_end_state=closed`,结束订单。
- `cancel`(撤单):`order_end_state=cancelled`,结束订单。
- `stopped_out`(止损触发):`order_end_state=stopped_out`,结束订单。

**校验体检**(`schemas.py:model_validator validate_stop_loss_direction`):止损方向体检**只对
`action_type in ("open", "add")` 生效**——多单止损必须低于入场价、空单必须高于入场价;对
`stop_loss_update`/`reduce` 等动作跳过体检(移动保本时止损可能等于/高于入场价,这是正常语义,
早年因为把这条规则套用到所有 action_type 上出过 18+4 条信号解析报错的事故)。trading-swarm 侧如果
自己也做类似体检,务必复用这条 `action_type` 白名单,不要对非开仓动作套用方向校验。

### A.5 Direct Push 推送模式(`subscription_push_attempts` / `console_targets`)

除 Agent Pull(推荐,见 A.3)外,Bridge 也支持主动推送到订阅者登记的 Console target
(`app/services/console_client.py` + `app/workers/push_worker.py`)。

**推送目标**(`ConsoleTarget` 模型,`app/models.py:252`):

```jsonc
// GET/POST/PATCH /api/v1/subscriber/targets 的对象形状(console_target_to_dict)
{
  "id": 1,
  "subscriber_id": 42,
  "name": "my-console",
  "base_url": "http://100.x.x.x:8787",
  "target_url": "http://100.x.x.x:8787/api/v1/external/signals",  // = base_url + 固定路径
  "ingest_token_configured": true,
  "ingest_token_masked": "sbk_***abcd",
  "status": "ACTIVE",           // ACTIVE | PAUSED
  "enabled": true,
  "last_status": "success",
  "last_status_code": 200,
  "last_error": null,
  "last_push_at": "2026-09-12T08:00:00+00:00",
  "created_at": "...", "updated_at": "..."
}
```

推送 URL 固定为 `{base_url}/api/v1/external/signals`(`target_url_for_base()`)。

**推送 payload**(bridge → console,`console_client.py:_payload`,与拉取端点里的 `envelope`
同构,只是 `event_id` 前缀不同):

```jsonc
{
  "event_type": "structured_signal.created",
  "event_id": "evt_<uuid4hex>",
  "producer": "<settings.producer>",
  "schema_version": "<settings.schema_version>",
  "payload": { /* StructuredSignal,同 A.4(不含 id/status 等 Response-only 字段) */ }
}
```

请求头:`Authorization: Bearer <ingest_token>`,`Content-Type: application/json`。

**推送记录**(`SubscriptionPushAttempt`,`app/models.py:303`,`GET /push-attempts` 返回体):

```jsonc
{
  "id": 1,
  "signal_id": "sig_xxx",
  "target_id": 1,
  "target_url": "http://.../api/v1/external/signals",
  "status": "SUCCESS",       // SUCCESS | FAILED(PushAttemptStatus)
  "status_code": 200,
  "response_body": "...",
  "error_message": null,
  "event_id": "evt_...",
  "created_at": "2026-09-12T08:00:00+00:00"
}
```

trading-swarm 若走 Direct Push(Bridge 主动推),需要自己在 `/api/v1/external/signals` 实现一个
接收端点,校验 `Authorization: Bearer <ingest_token>`,body 就是上面这个推送 payload。但**推荐
Agent Pull**(A.3),原因见 README:Direct Push 要求 Bridge 能直接网络可达 trading-swarm,跨机/跨
NAT 场景下不现实,Pull 模式反过来由 trading-swarm 主动轮询 Bridge,天然适配任意网络位置。

### A.6 curl 示例(占位 token,基址 `https://<bridge-domain>`)

```bash
# 1) 起步游标:按订阅者可见口径拿"最近 50 条"的安全起点
curl -sS "https://<bridge-domain>/api/v1/subscriber/me?recent=50" \
  -H "X-API-Key: sbk_REPLACE_ME" \
  -H "X-Secret-Token: sbs_REPLACE_ME"

# 2) 长轮询拉取(after_id 来自上一步 recent_after_id,或上一轮响应的 scanned_to_id)
curl -sS "https://<bridge-domain>/api/v1/subscriber/signals?after_id=1198&limit=50&wait_seconds=10&agent_id=trading-swarm&instance_id=prod-1" \
  -H "X-API-Key: sbk_REPLACE_ME" \
  -H "X-Secret-Token: sbs_REPLACE_ME"

# 3) 单条投递回执
curl -sS -X POST "https://<bridge-domain>/api/v1/subscriber/agent-deliveries" \
  -H "X-API-Key: sbk_REPLACE_ME" \
  -H "X-Secret-Token: sbs_REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"signal_id": "sig_xxx", "agent_id": "trading-swarm", "status": "SUCCESS", "status_code": 200}'

# 4) 批量回执(补历史用,≤500 条/批)
curl -sS -X POST "https://<bridge-domain>/api/v1/subscriber/agent-deliveries/batch" \
  -H "X-API-Key: sbk_REPLACE_ME" \
  -H "X-Secret-Token: sbs_REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"deliveries": [{"signal_id": "sig_xxx", "agent_id": "trading-swarm", "status": "SUCCESS"}]}'
```

---

## B. 8794 带单员统计(console-api)与 strategy-public-api

### B.1 本机 8794 是谁

本机跑着多个 trade-switch-rs 实例,通过各自 `data/listen-port` 文件确认端口归属
(`console-api` 的 `--port 0` 会让 OS 分配端口并把**实际**端口写进这个文件,见
`backend/crates/console-api/src/main.rs:120-127`):

| 目录 | 端口 |
|---|---|
| `~/Desktop/trade-switch-tp-demo` | 8797 |
| `~/Desktop/trade-switch-v2` | 8788 |
| `~/Desktop/trade-switch-fresh-shadcn` | 8789 |
| **`~/Desktop/trade-switch-dev-hedge`** | **8794** |
| `~/Desktop/trade-switch-fresh-classic` | 8790 |

即:**8794 = `trade-switch-dev-hedge` 这个 app-data root**,配置文件是
`~/Desktop/trade-switch-dev-hedge/config/settings.json`(源码里固定拼
`root.join("config/settings.json")`,见 `core.rs:18323`)。

### B.2 鉴权字段(只报字段名,不写 token 值)

配置文件顶层 `console` 段(`core.rs:3586-3617`,`lib.rs` 中间件 `auth_middleware`):

- `console.auth_token`:非空则启用鉴权,持有者是 `Full` 角色(读写全开)。请求头二选一:
  `X-Auth-Token: <token>` 或 `Authorization: Bearer <token>`。
- `console.readonly_token`:可选只读令牌,持有者是 `ReadOnly` 角色——只放行 GET(含 SSE),
  所有写操作 403,且一批"含密 GET"白名单端点(`/api/exchange/credentials`、
  `/api/notification-settings`、`/api/console-agent-settings`、`/api/agent-runtime/settings`、
  `/api/signal-bridge-settings`、`/api/mcp/install-info`,见 `lib.rs:328` `READONLY_SENSITIVE_READS`)
  也一律 403。**trading-swarm 只读取统计数据,应该用 `readonly_token`,不要用 `auth_token`。**
  防呆:`readonly_token` 为空或与 `auth_token` 相同时视为未启用。
- `console.mcp_token`:第三个角色 `Proposal`(对外 MCP 用,只读 + 白名单提案 POST),与
  trading-swarm 场景无关,不建议使用。

**当前本机状态**:实测 `trade-switch-dev-hedge/config/settings.json` 的 `console` 段只有
`mcp_token` / `setup_completed` 两个键,`auth_token`/`readonly_token` 均未配置(空)——也就是说
本机 8794 目前**没有启用鉴权**,走的是"Host/Origin 必须是本机"防线(`lib.rs:397` 起的
`auth_middleware`:未配置 `auth_token` 时,请求 Host 必须匹配 `127.0.0.1`/`localhost`/`[::1]`/
`tauri.localhost`,带 `Origin` 的跨站请求同样要求本机来源,否则 403 `forbidden_origin`)。
若 trading-swarm 要跨机访问 8794,必须先在该 `settings.json` 里配置 `console.readonly_token`
(推荐)或 `console.auth_token`,否则永远打不通。

### B.3 端点清单(`backend/crates/console-api/src/lib.rs` 路由表)

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/copytrading/trader-stats` | 按带单员聚合的统计(胜率/回撤/曲线等),**不分窗口**(全量) |
| GET | `/api/leaderboard?window=&sort=&order=&{economics params}` | 带窗口/排序/经济口径的排行榜(推荐用这个拿胜率/回撤/夏普相关指标) |
| GET | `/api/leaderboard/{source}/detail?window=&{economics params}` | 单个带单员详情(含权益曲线、白名单字段的跟单配置) |
| GET | `/api/copytrading/trader-stats/{source}/replays` | 该带单员的逐笔回放明细(全量,不分窗口) |

`{source}`/`trader-stats` 里的 `source` **是带单员名字**(如"交易员A""交易员B"),不是传输源
(lark/telegram)——代码里专门做了 `thread_key → trader` 的映射来纠正这个命名(见
`core.rs:11971` `trader_replays` 的注释:"入参是**交易员名**…但 shadow_replays.source 存的是
传输源…直接按列过滤永远空")。

`window` 取值:`7d | 30d | 90d | all`(默认 `all`,`parse_leaderboard_window`,`core.rs:292`)。
`sort` 取值:`return | winrate | expectancy | drawdown` 等(默认 `return`)。`order`:排序方向。
经济口径参数(影响杠杆/费率假设,透传自查询串,键名见 `ReplayEconomics::QUERY_KEYS`)包括
`leverage_mode`(`uniform`/`declared`)、`uniform_leverage`、`apply_fees`、`taker_fee_pct`、
`apply_funding`、`funding_pct_per_8h`、`default_margin_pct`、`margin_mode`(`isolated`/`cross`)。

**注意:8794 本身不产出 `sharpe` 字段**——`aggregate_trader_stats`/`stats_with_leverage`
(`core.rs:990-635`)里没有夏普比率的计算,只有 `win_rate` `expectancy_r`(平均 R)
`profit_factor` `max_drawdown_pct` `total_return_pct` 等。夏普比率是 `strategy-public-api`
自己算的(见 B.5,`sharpeRatio1y`,年化、按日重采样)。若 trading-swarm 需要夏普,应该对接
strategy-public-api 而不是直接打 8794。

### B.4 `/api/leaderboard` 与 `/trader-stats` 的返回字段(`aggregate_trader_stats` / `stats_with_leverage`,`core.rs:990` 起)

```jsonc
// GET /api/leaderboard 中 "traders" 数组的每个元素(stats_with_leverage 在 aggregate 基础上叠加杠杆相关字段)
{
  "source": "交易员A",                    // 实为 trader 名
  "signals_total": 60,
  "no_fill": 2,
  "awaiting_fill": 0,                  // 入场窗口未走完,既不算接到也不算没接到
  "liquidations": 0,
  "first_liquidation_index": null,     // 第几笔(1-based,入场时间序)爆的仓,复利曲线自此恒 0
  "excluded_no_data": 0,               // K线缺失/覆盖不全被剔除的样本数
  "open": 2,                           // exit_reason == "open" 的笔数,即在途仓位
  "resolved": 58,                      // exit_reason in (tp, sl, signal_close, flipped) 才计入分子分母
  "wins": 37, "losses": 21,
  "win_rate": 63.79,                   // % ,基于 resolved,不含 open/no_fill/awaiting_fill
  "avg_r": 0.42, "expectancy_r": 0.42, // 逐笔 R 均值
  "profit_factor": 2.94,
  "equity_curve_r": [0.1, 0.3, ...],   // 累计 R 曲线
  "equity_curve_pct": [1.2, 3.4, ...], // 复利收益曲线(%),按入场时间排序
  "total_return_pct": 972.0,
  "total_pnl_usdt": 97200.0,           // = (equity-1) * base_notional
  "base_notional": 10000.0,
  "fill_rate": 96.6,
  "avg_hold_seconds": 102000.0,
  "freq_per_week": 7.8,
  "max_drawdown_pct": 30.52,           // 复利曲线峰谷跌幅,正数(不是负号表示)
  "dominant_side": "long",
  "first_signal_at": 1782823200.0,     // epoch 秒
  "last_signal_at": 1788129900.0,
  // 以下字段只在 leaderboard(stats_with_leverage)里有,trader-stats(纯 aggregate)没有:
  "avg_leverage": 3.0,
  "avg_effective_leverage": 3.0,       // 杠杆 × 仓位比重
  "sizing_declared": 40,               // 带单员真声明了仓位比重的笔数
  "sizing_defaulted": 18,              // 用默认估算的笔数
  "sizing_below_full": 5               // applied_margin_pct < 100% 的笔数
}
```

`/api/leaderboard/{source}/detail` 额外给逐笔明细里套用了经济口径的行(每行来自
`apply_replay_economics`,`core.rs:502`),关键字段:

```jsonc
{
  "pnl_pct": ...,          // 【坑 1,见 B.6】经济口径套用后的"账户口径"收益(已加杠杆/仓位比重,已扣成本),
                            //  不是原始未加杠杆的价格收益——这个字段名在不同层含义会变,见下方坑说明
  "raw_pnl_pct": ...,       // 原始价格变动百分比(未加杠杆的毛收益)
  "uncapped_pnl_pct": ...,  // 不封顶的账户口径收益(算盈亏比用,避免爆仓截断压低分母)
  "applied_leverage": ..., "applied_margin_pct": ..., "effective_leverage": ...,
  "liquidated": true/false,
  "exit_reason": "tp" | "sl" | "signal_close" | "flipped" | "no_fill" | "awaiting_fill" | "open",
  "entry_ts": ..., "exit_ts": ..., "r_multiple": ..., "side": "long"/"short", "sizing_source": "declared"/"default"
}
```

### B.5 `strategy-public-api` 返回形状(`API.md`,数据源直接是 8794,见 `app/console.py` 首行注释
"console 8794 只读客户端"与 `app/compute.py` 首行注释"复盘数字全部透传 console")

Base URL:`https://srv1889788.hstgr.cloud`(仅 HTTPS)。鉴权:`X-Auth-Token: <token>` 或
`Authorization: Bearer <token>`(线下发放,建议放服务端转发,不进浏览器)。全部 `GET`,裸 JSON。

- `GET /strategies/ranking?window=24h|7d|30d|all&mode=roi`:排行榜,`strategies[]` 每项含
  `id name category rank returnPct maxDrawdownPct winRatePct tradeCount series[{t,value}]`。
- `GET /strategies/{id}`:详情一次取齐,分四块——
  - `profile`:`id name avatarUrl category tags description badge rank followers sinceAt`
  - `kpis`:`totalReturnPct totalReturnSpark updatedAt maxDrawdownPct drawdownFromPct
    drawdownToPct drawdownFromAt drawdownToAt drawdownSpark sharpeRatio1y sharpeLabel
    sharpeSampleDays`(**夏普只在这里**,年化、近 1 年按日重采样,样本<5 天为 null)
  - `riskOverview`:`level lowPct mediumPct highPct sampleCount`
  - `returnDistribution` / `distributionMeta`:单笔净收益直方图
  - `monthlyReturns`:`month returnPct partial`
  - `stats`:`totalTrades openTrades winRatePct profitFactor bestTradePct worstTradePct
    avgTradePct holdingPeriodDays tradesPerWeek liquidations leverage dominantSide avgMaePct avgMfePct`
- `GET /strategies/{id}/replays?pair=&status=open|closed&limit=1~500`:逐笔回放,每项含
  `id pair baseAsset direction leverage status entryTime entryPrice entryLegs exitTime
  exitPrice exitReason grossReturnPct netReturnPct pnlUsdt maePct mfePct liquidated`。
  `grossReturnPct` = 未加杠杆纯价格收益(对应 8794 的 `raw_pnl_pct`);`netReturnPct` = 加杠杆扣费后
  净收益(对应 8794 经济口径后的 `pnl_pct`)。
- `GET /strategies/{id}/returns?range=all|1y|6m|3m|1m&interval=1h|4h|1d|1w`:累计收益曲线
  `{range interval mode endPct series[{t,value}]}`。

### B.6 两个坑(用户明确要求标注)

1. **`pnl_pct` 是未加杠杆的毛收益,不能直接当账户损益用。**
   - 在 8794 的原始 `shadow_replays` 表行(`apply_replay_economics` 入参前)里,`pnl_pct` 存的是
     **价格变动百分比**,与杠杆、仓位比重、手续费、资金费全都无关(`core.rs:317` 注释:
     "R57 排行榜经济口径:回放行里存的 `pnl_pct` 是**价格变动百分比**…杠杆和成本在读时套用")。
   - `strategy-public-api` 的 `app/compute.py` 顶部注释把这条坑写得更直白:
     "逐笔数据(成交/回放明细)来自 `/replays` 全量接口,其 `pnl_pct` 是**未加杠杆毛价格收益**;
     净收益 = 毛×lev − 双边 taker×lev − 资金费×lev×持仓/8h"。
   - **推论给 trading-swarm**:如果直接读 8794 `/api/copytrading/trader-stats/{source}/replays`
     的原始 `pnl_pct` 字段去算账户级盈亏,会**系统性低估**(缺杠杆放大)。要么用
     `/api/leaderboard/{source}/detail` 里经过 `apply_replay_economics` 处理后的 `pnl_pct`
     (账户口径,但字段名和原始表字段撞了,要认清是哪一层的响应),要么用
     `strategy-public-api` 的 `netReturnPct`(明确是加杠杆扣费后的值),不要用它的
     `grossReturnPct` 当账户损益。

2. **`exit_reason == "open"` 表示在途(仍持仓),不是"已平仓"。**
   - `aggregate_trader_stats`(`core.rs:1007`)把 `exit_reason == "open"` 的笔数单独计入 `open`
     字段,并且**排除**在 `resolved`(已结算,进胜率/盈亏比分母)之外——只有
     `tp | sl | signal_close | flipped` 才算已结算。
   - `strategy-public-api` 的 `app/compute.py:174` 专门有一个 `is_open()` 辅助函数并附注释:
     "引擎对在途回放会写滚动 `exit_ts` 且 `exit_reason='open'`,不能只看 `exit_ts` 判断是否
     已平仓"——也就是说**`exit_ts` 非空也不代表已平仓**,必须同时检查 `exit_reason != "open"`。
   - **推论给 trading-swarm**:任何"胜率/盈亏比/已结算笔数"的计算,过滤条件必须同时满足
     `exit_reason not in ("open", "no_fill", "awaiting_fill")`,并且判断"是否仍持仓"时要看
     `exit_reason == "open"`,不能只看 `exit_ts` 是否为空。

---

## C. trading-swarm 内部数据模型映射建议

以下映射基于 A/B 两节的字段调研,供 trading-swarm 实现 ingest/normalize 层参考。

### C.1 Bridge 信号 → trading-swarm 内部信号

```
{
  trader:        envelope.payload.metadata.trader
  symbol:        envelope.payload.symbol                         // 已是大写,直接用
  side:          envelope.payload.side                           // long | short | close_long | close_short
  entry_kind:    envelope.payload.entry.type                     // "market" | "limit" 等,字段本身是自由 dict,需按 "type" 键取,缺失时按 metadata.action_type 兜底判断
  entry_prices:  [envelope.payload.entry.price] 或 envelope.payload.entry.prices   // 需要归一化成数组:单价包一层,区间/多档直接用
  stop:          envelope.payload.stop_loss?.price ?? null       // stop_loss 是自由 dict,常见 {price}
  tps:           envelope.payload.take_profit?.map(tp => ({ price: tp.price, pct: tp.pct ?? null })) ?? []
  action:        envelope.payload.metadata.action_type           // open|add|reduce|close|stop_loss_update|take_profit_update|stopped_out|analysis_only|unknown|cancel
  ref_signal_id: envelope.payload.metadata.target_order_ref || null
  valid_until:   envelope.payload.valid_until                    // 可能为 null
  published_at:  envelope.payload.created_at                     // Bridge 侧 StructuredSignalResponse.created_at(信号入库时间)
  ingested_at:   trading-swarm 自己拉取/接收到这条信号的本地时间戳,不取自 payload
}
```

补充注意:
- `record_id`(拉取响应里的游标字段)和 `signal_id`(业务唯一 ID)是两个不同的东西——游标持久化
  要存 `scanned_to_id`,业务去重/回执要用 `signal_id`。
- `order_end_state` / `rationale` 建议原样透传进 trading-swarm 的 metadata 透传字段(便于人工复核和
  下游状态机判断“这一条是不是结束一笔单子”),不建议丢弃。
- `action_type` 为非 `open`/`add` 时,`stop_loss` 可能"看起来不合逻辑"(比如等于入场价,那是
  移动保本的正常语义),trading-swarm 自己的风控体检如果做类似方向校验,要复用 A.4 里的
  `action_type in ("open","add")` 白名单,否则会误伤移动止损/移动保本类信号。

### C.2 8794 统计 → trading-swarm 内部统计

```
{
  trader:          leaderboard traders[].source            // 名字虽然叫 source,实为带单员名
  window:          请求时传入的 window 参数原样带回(7d|30d|90d|all)，接口本身不在响应体里回显 window，trading-swarm 需要自己记
  trades:          traders[].resolved                       // 已结算笔数,不含 open/no_fill/awaiting_fill
  win_rate:        traders[].win_rate                        // 已是百分数(如 63.79),不用再 *100
  sharpe:          8794 本身不提供 —— 需改调 strategy-public-api `/strategies/{id}` 的 kpis.sharpeRatio1y(年化,近1年,样本<5天为null)；若坚持只用 8794，此字段留空/null 并在 trading-swarm 侧标注数据源缺失
  max_dd_pct:      traders[].max_drawdown_pct                // 正数表示跌幅（不是负号语义），trading-swarm 若约定"负数=回撤"需自己取负
  net_return_pct:  traders[].total_return_pct                // 复利口径累计收益率(%)，若要与 strategy-public-api 对齐用同名字段 totalReturnPct/endPct
  updated_at:      响应体本身不带 updated_at —— trading-swarm 需要用请求发起时刻的本地时间戳做 updated_at，不要臆造一个不存在的服务端字段
}
```

补充注意:
- 若 trading-swarm 选择对接 `strategy-public-api` 而非直连 8794(推荐,因为夏普只有那边有,且
  已经做好了口径对齐 + 鉴权 + 限流/缓存),字段来源改为:`trades = stats.totalTrades`,
  `win_rate = stats.winRatePct`,`sharpe = kpis.sharpeRatio1y`,`max_dd_pct = kpis.maxDrawdownPct`
  (注意这里是**负数**语义,`-30.52` 表示回撤 30.52%,与 8794 原始的正数语义相反,映射时要统一
  符号约定),`net_return_pct = kpis.totalReturnPct`,`updated_at = kpis.updatedAt`(这个接口
  确实自带 `updatedAt` 字段,直接用,不用臆造)。
- `window` 在 8794 与 strategy-public-api 的取值集合不完全一致(8794: `7d|30d|90d|all`；
  strategy-public-api ranking: `24h|7d|30d|all`，returns: `all|1y|6m|3m|1m`),trading-swarm 内部
  枚举需要单独定义,不能假设两边共用一套字符串。
