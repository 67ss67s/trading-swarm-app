# 8794(Trade Switch 控制台)功能盘点 —— 供新 gate 对齐/借用(2026-09-02 工作线报告整理)

仓库 `~/Desktop/trade-switch-dev-8793`(8794 实盘基线,**只读参考,不动**)。后端 Rust/axum/sqlx-sqlite:`backend/crates/{console-api, console-core, console-db, console-types, account-hub}`;前端 `frontend/`(classic)+ `frontend-design/`(shadcn)+ `frontend-shared/`。路由全部集中在 `console-api/src/lib.rs:96-303`。

## 1. HTTP API 面(按组)
- **健康/状态/SSE**:`/api/health`(setup_completed/auth_required/mode,豁免鉴权)、`/api/auth/whoami`(open/full/readonly/proposal)、`/api/events/ticket`(30s 一次性 SSE ticket)、`/api/events/stream`、`/api/state`(app/exchange/risk/signals/orders/events/action_plans/positions 全快照)、`/api/server-info`。
- **行情/K线/图表**:`/api/market/price|prices|klines|live-price|indicators|indicator-series`、`/api/klines/store-status`、`/api/klines/backfill`、`/api/chart/structure`(确定性结构引擎)、`/api/chart/drawings`(GET/POST/DELETE,32KB 限)+`/{id}`、`/api/exchange/symbols`。
- **自定义指标/Pine**:`/api/indicators/custom`(+validate/translate/{id}/delete)、`/api/indicators/pine/run`、`/pine-catalog`、`/api/mcp/install-info`。
- **账户/持仓/订单**:`/api/account/balances|info|positions|pnl|trade-analysis`、`/api/open-orders`、`/api/trades`、`/api/order-history`、`/api/positions/close-market`、`/api/exchange/position-mode`(单向↔双向)、`/api/exchange/credentials`(+test)。
- **下单/撤改/TWAP/仿真**:`/api/orders/preview-from-signal`、`cancel`、`cancel-all`、`modify`、`liq-preview`、`{order_id}/retry`、`twap`(+cancel)、`/api/sim/tick|run-engines|external-close`(仅 dry_run)。
- **信号**:`/api/signals`(POST)、`/signals/parse`、`/signal-events`、`/api/v1/external/signals`、bridge 设置/状态/raw-events、`/external-signal-settings`、`/signal-stream/settings`。
- **策略线程/保护腿/条件出场**:`GET /api/strategies`(工作台:叠加实时持仓、桶、attention、entry_execution)、`POST /api/strategies/{thread_id}/attention/resolve`、`POST /api/strategies/{thread_id}/conditional-exit`(人点一次才执行)、`/api/cycles/registry|backfill`。
- **管理计划**:`GET /api/order-management`、`POST /plans/{id}/execute`(**唯一真动钱的那条,刻意与记账动作分开**)、`/plans/{id}/{action}`(纯记账)、`/bulk`、`/auto-apply`(false→true 需 confirm=true 否则 409)。
- **草稿闸(action_plans)**:`GET /api/agent-runtime/intents`、`POST /intents/{id}/confirm`(TTL 过期→expired)、`POST /intents/{id}/cancel`;事件 `agent_runtime.intent_created|confirmed|cancelled`;口径:**模型只能造草稿,执行必须人点**;上限 `control.max_margin_usdt / max_notional_usdt / intent_ttl_seconds`。
- **Agent 聊天/会话/MCP**:`/api/agent-runtime/settings|chat|mcp/tools|mcp/import|sessions(+/{id}|delete|update)`、`/api/agent-heartbeat/jobs`。
- **Agent 工具全表**(`agent.rs:778-970`):基础 19(`get_state get_positions get_open_orders get_copy_settings get_strategies get_signal_events get_management_plans get_pnl get_leaderboard get_market_price get_klines get_volume_profile get_indicators macro_snapshot list_event_triggers list_custom_indicators save_memory create_custom_indicator create_event_trigger`)+ 绘图读 2(`list_drawings get_drawing`)+ `get_chart_structure`(drawing_focus)= 22 常驻;+ 绘图写 3(`create/update/remove_drawing`)+ `create_trade_draft`(create_draft 权限)+ 订单管理 3(`cancel_order place_protective_order apply_management_plan`,manage_orders 权限)= 最多 28。通道闸:Telegram 默认无 manage_orders;Trigger 通道永远无 manage_orders 且绘图只读。`apply_management_plan` 要求结构化 confirm 逐字回填 plan_id/action/percent/symbol(防注入)。
- **触发器**:`/api/event-triggers`(GET/POST/test/simulate-fire/{id}/delete);17 种条件(price/candle/rsi/ema/macd_hist/indicator/cross/round_number_cross/change_percent/volume_spike/custom…)、多周期共振、`logic all|any`、`agent_draft` 触发即让 agent 出草稿;周期 15 档 1m…1M。
- **影子回放/排行/画像**:`/api/leaderboard`(+/{source}/detail)、`/api/copytrading/trader-stats|shadow-replays|shadow-replay-detail`、`/api/reconciliation`、copy 设置、`/api/trader-identity`、`/api/factor-studio/*`。
- **设置/风控/系统**:`/api/settings/mode`、`/api/emergency-stop`、`/api/risk-settings`、通知设置(+test/discover-telegram)、`/api/network/settings|test`、`/api/setup/complete`、`/api/update/*`、`/api/hub/{*rest}`(多账户中枢同源代理)。
- **console-agent 旁车**:进程内 tokio task(不再是 Python 子进程),错误分类/有界重试/DLQ/指数退避。
- **鉴权**(`lib.rs:374-560`):token 只从 `X-Auth-Token` 或 `Authorization: Bearer`;4 角色 Open(Host/Origin 本机校验防 DNS rebinding)/Full/ReadOnly(只 GET,且 6 个泄密 GET 拒)/Proposal(`console.mcp_token`,只读 + 5 条提案写路由:event-triggers 强制 enabled=false、indicators translate/validate、pine/run、agent-runtime/chat 只出草稿);SSE 用 30s 一次性 ticket,`?token=` 已删。
- **SSE 事件**(~170 种,`core.rs:2199` 统一 `event()` 落库+广播):`order.*`(submitted/validated/validation_blocked/submit_lost/unknown_state/recovered_after_error/…)、`orders.reconciled|cancel_all`、`exchange.*`、`protection.*`(repaired/resized/legs_merged/gap_critical/…)、`attached_exit_order.*`、`signal.*`、`external_signal.*`、`signal_management.*`(~45 种)、`strategy.*`、`position(s).*`、`risk.*`+`risk_liq_warn|critical`、`copytrading.*`、`account.*`(ws_connected/ws_degraded/rest_fallback/reconcile_failed/multi_writer_detected|cleared)、`market.ws_*`、`trigger.*`、`twap.*`、`agent.*`、`agent_runtime.intent_*`、`mode.*`、`core.started`、`sim.*`。`push_category` 映射到 6 个 TG/Lark 分类(orders/rejected/cancels/protective/risk/copytrade/system)。

## 2. 策略线程状态机(**做得好的部分,直接借**)
两层刻意分开:
- **A. 派生策略状态** `STRATEGY_STATES`(`console-core/src/strategy.rs:24`):`pending → open → managing → closing → closed`,终态 `superseded / invalid`。派生逻辑顺序敏感(`strategy.rs:851-887`):`closed` **只在关仓单真正成交后置**;只收到平仓信号未成交 → `closing`;`entry_aborted`(入场腿全终态零成交)+平仓信号 → 直接 closed。**按读派生、不引入第二真相源**,用户手动在交易所平仓也不漂移。
- **B. 工作台桶** `WORKBENCH_BUCKETS`:`attention / pending / holding / ended / abnormal`,纯函数 `derive_strategy_workbench(strategy, position_gone)`(`strategy_workbench.rs:279`)——"人该看什么"的唯一口径。20 个 attention 码(MANAGEMENT_REVIEW_REQUIRED / CLOSE_SIGNAL_NOT_SUBMITTED / CLOSE_ORDER_STALLED / EXIT_UNCONFIRMED / PROTECTION_MISSING / MANAGEMENT_TARGET_STALE / ORDER_PARTIALLY_FILLED_STALE / STRATEGY_INVALID / ORPHAN_ORDERS / EXECUTION_HISTORY_ORDERS / CONDITIONAL_EXIT_PENDING|STALE / TRADER_CLOSE_IN_LATER_SEGMENT / POSITION_GONE(_UNEXPLAINED) / ORDER_REJECTED / ORDER_STATE_UNKNOWN / MANAGEMENT_TARGET_UNMATCHED / MANAGEMENT_ORDER_FAILED);`UNRESOLVABLE = [ORDER_STATE_UNKNOWN, PROTECTION_MISSING]`(资金安全码不许静音);**attention 指纹**(code+定性参数,条件实质变化就让静音自动失效)。
- **C. 信号生命周期**:`SIGNAL_STATUS_GROUPS = valid/observed/applied/management/invalid/ended`;订单状态四张表 ACTIVE / LIVE_OR_SUBMITTED / FAILED / ACCEPTED(R64 把 `/order/test` 回执踢出"已受理")。
- 好在哪:纯派生+纯函数可穷举单测;state(事实)与 bucket(人看什么)分离;`entry_execution.eligible` 单独回答"能不能开";attention 码带 fingerprint 让静音可逆。

## 3. 风控与闸门
- 模式 `mode ∈ {dry_run, paper, live}` + `risk.emergency_stop`(=HALT_ALL,`risk.rs:142` 第一道拒);前端会话级"仅平仓"(=FLATTEN_ONLY)。
- `risk.*`:`max_leverage`(100)、`max_position_percent`(0.5 名义÷权益,对所有开仓腿)、`max_signal_age_seconds`(180)、`allowed_symbols`(BTC/ETH/SOL)/`blocked_sources`/`allowed_sources`、`max_price_deviation_percent`(0.55)/`max_aggressive_limit_deviation_percent`(0.05)、`planned_submit_grace_seconds`(300,判提交链断裂)、`auto_cleanup_cooldown_minutes`(10)、`auto_cleanup_protections`(true)、`conditional_exit_auto`(false,四道硬门)、`allow_agent_live_trading`(false)、`single_writer_guard`(block|warn|off)、`liq_alerts.{enabled,warn_pct 25,critical_pct 12,cooldown,rearm}`、`entry_expiry_hours`。
- Agent 侧 `agent.control.*`:`trading_enabled`(false)、`max_margin_usdt`(500)、`max_notional_usdt`(1000)、`allowed_symbols`、`intent_ttl_seconds`(120)。
- 自动执行组 `order_management.auto_apply.*`:reduce/stop_loss/take_profit 默认关,`cancel` 默认开(只收回入场单),freshness 300s;**close 永远不在自动组**。
- 保护腿硬开关:`HEDGE_OVERCOVERAGE_TRIM_ENABLED=true`、`OVERCOVERAGE_RESIZE_ENABLED=false`。

## 4. LLM provider 配置(可对齐)
`data/agent_config.json`:`adapter: api|cli|both`;`ai{enabled, provider:"deepseek", base_url, model, api_key, api_key_env:"DEEPSEEK_API_KEY", request_timeout_seconds:90, temperature:0.2}`;`cli{enabled, adapter:"claude"|"codex", timeout_seconds:90}`。
- 统一走 OpenAI 兼容 `POST {base_url}/chat/completions`;无 Anthropic 原生分支。密钥 env 优先;GET 掩码、POST 空/带 * = 不变。
- **CLI 通道**:`/deep` 开头消息转本地 `claude`/`codex` 二进制(`run_cli_completion`,`agent.rs:1989`)。
- **代理**:进程级 `network.{proxy_mode: auto|manual|direct, proxy_url, no_proxy}`,env 在 tokio 起来前注入,manual 模式启动自检不通过**拒绝启动**;WS 单独 `connect_ws_via_proxy`(CONNECT 隧道+SOCKS5)。
- MCP:`agent.mcp.servers`(HTTP transport + stdio 子进程注册表,协议 2024-11-05)。

## 5. K线存储
- `data/klines.sqlite3` 与主库分离可重建;`klines(symbol,interval,open_time,o,h,l,c,v PK(symbol,interval,open_time))` + `kline_coverage(symbol,interval,start_ms,end_ms)`(只存首尾,中间缺口靠 21600s 探测补);WAL。
- 周期 15 档;REST 冷启动 `/fapi/v1/klines` 分页 1500×400;WS `wss://fstream.binance.com/stream` 只写已收盘 K;热订阅 LRU(600s/24 流);历史起点 2026-01-01。
- console-core 模块:`assets audit config copy cycles exchanges(binance,dry_run) indicators(34 个 ta 指标) ledger orders(adapter,planner) protection risk shadow(引擎版本 11) signals(lifecycle,management,parser,external,schema,status) strategy strategy_workbench structure(确定性画线结构引擎) util`。
- 主库表:events / signals / orders / action_plans / positions / external_signal_events / signal_management_plans / account_snapshots / agent_chat_sessions|messages / agent_heartbeat_jobs / agent_memory / event_triggers / shadow_replays(_custom) / chart_drawings / attention_resolutions / position_exit_resolutions / strategy_cycles / signal_cycle_links / cycle_aliases。

## 6. 前端
- classic 14 页(overview signals strategies strategy-detail leaderboard trade copy account chart indicators triggers agent integrations settings);shadcn 16 页分 trading/automation/system 三组(dashboard trade chart indicators | triggers copy strategies factor-studio leaderboard reconciliation | agent account risk settings)。
- 图表 **lightweight-charts v5** + fancy-canvas;可切 TradingView 官方 widget iframe(CSP 放行 s.tradingview.com);多 pane(主图→成交量→每振荡器一 pane);绘图层共享 `useDrawingLayer` + `palette.ts`(role+state→颜色/透明度/线型契约)。
- SSE 消费 `useEventStream.ts`:token→换 30s ticket→EventSource(`?ticket&last_event_id`),退避 1s→30s,断线补发;按事件前缀精准失效 react-query;SSE 在线时主轮询放宽到 120s。
- 桌面 Tauri 壳 `desktop/`。

## 7. Binance 连通性(gate 用 MCP,这里主要借纪律)
- 适配器 `console-core/src/exchanges/binance.rs`(4574 行,USDT-M):HMAC 签名、服务器时间偏移 30min 同步、进程内令牌桶 720 权重/分钟(IP 上限 2400 的 30%,主网/测试网共用 IP 账本)、`RestGate::{Ready,Wait,Banned}`(交易所已拒时一秒不等,MAX_HONORED_BAN 900s)。
- 环境 `environment: testnet|live`、`market_data_environment: live(默认)|follow_trading`(**公共行情钉主网**防测试网假撮合污染)、`test_order`、`allow_live_orders`、`recv_window 60000`。
- 持仓模式 `position_mode_expected: one_way|hedge`,每单实查比对不一致 fail-closed。
- 用户数据 WS(`account_stream.rs`):**断流即 stale**,可限流 REST 对账,绝不静默信缓存;`STALE_AFTER 600s`、`REST_FALLBACK 10s`。
- 行情 WS 双通道:`ws-fapi.binance.com/ws-fapi/v1`(request/response,每 2s 全量 ticker.price)+ combined-stream kline/markPrice。
- **单写者**四层:账户级多写者检测(clientOrderId 前缀分本机/外部→sticky KV `multi_writer_state`+30min 限流事件,读失败不定罪)、跟单准入闸 `single_writer_guard`、引擎写者互斥(pid 文件)、引擎链单飞 `SingleFlightLease`(RAII,固定顺序:auto_cleanup_stale_orders → cleanup_expired_entries → submit_deferred_protective_legs → ensure_protection_coverage → maintain_conditional_exits → normalize_account_orders → reconcile_trader_exits → resolve_position_gone_evidence → sweep_management_plans;对账 600s、保护覆盖 90s)。
- 多账户 `account-hub`:每账户独立 `--root` 实例,hub 只管注册/启停/健康,自身不是写者。
