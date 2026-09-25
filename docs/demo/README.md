# Demo 运行时(2026-09-03)—— 影子判断 + Binance Demo Trading 执行

> 目的:在不碰真钱、不依赖 Binance 自建 MCP 客户端的前提下,把「事件触发 → JudgmentEpisode → 有限判断 → 策略状态机 → (演示账户)执行 → 回放」整条链跑给人看。
> 口径来自 `~/Desktop/trading-swarm-eval/harness-assessment-and-eval-plan.md`(§4/§5/§9/§11):Agent 只在触发时读新鲜状态、维护 thesis、输出有限判断;数量/风险/执行由代码决定;每次判断可回放。
> **不是 A2**:六记录状态机/plan 物化/durable 队列不在这里做;Codex NO-GO 的 P0 仍然挡着 live。本运行时只允许两种执行后端:`paper`(进程内模拟)与 `demo`(`https://demo-fapi.binance.com`,币安官方演示环境,假钱)。

## 1. 进程与包

| 进程 | 包 | 职责 |
|---|---|---|
| gateway(Node 24) | `packages/gateway/src/demo/` | 行情采集(公共 fapi,无 key)、调度(K 线收盘 / 手动)、EpisodeBuilder、ContextBuilder、大脑适配(pi/GLM 或 claude CLI)、Strategy reducer、纸面账户、HTTP API + SSE、`state.sqlite` 新表 |
| tswarm-demo-exec(Rust,exec-core 的 bin) | `crates/exec-core/src/bin/tswarm-demo-exec.rs` | **唯一持有 demo API key 的进程**;stdin/stdout NDJSON;base URL 硬编码 `FAPI_DEMO`,拒绝任何覆盖;place 必须带 clientOrderId |
| webui(Vite+React) | `packages/webui/` | 单页:agent 时间线(人话)+ 策略卡 + 账户卡 + 迷你 K 线;dev 时 `/api` 代理到 gateway |

gateway 监听 `127.0.0.1:18800`(设计 §14 默认口)。凭证文件 `~/.trading-swarm/secrets/apikey-demo.json`(`{"api_key":"…","api_secret":"…"}`,0600),只有 Rust 读。没有这个文件 → 自动落到 `paper` 后端,UI 顶部 chip 显示「纸面模拟」而不是「Demo Trading」。

## 2. 领域对象(gateway 本地,JSON,snake_case,金额十进制字符串,时间 unix 毫秒)

```ts
type StrategyState = 'researching'|'watching'|'ready'|'active'|'managing'|'closing'|'closed'|'invalidated';
type Action = 'NO_TRADE'|'WATCH'|'PROPOSE'|'HOLD'|'ADD'|'REDUCE'|'EXIT'|'INVALIDATE';
type Direction = 'long'|'short';

interface Strategy {
  id: string; symbol: string; timeframe: string;      // 'BTCUSDT','1h'
  state: StrategyState; version: number;
  direction: Direction | null;
  thesis: string;                                     // 一句话论点(人话)
  entry_plan: string | null;                          // 入场条件(人话)
  invalidation: string | null;                        // 失效条件(人话)
  invalidation_price: string | null;                  // 可选,给图表画线
  target_price: string | null;
  watch_conditions: string[];                         // 下一次要看什么
  risk_budget_pct: string;                            // 单笔风险占权益 %,代码定,模型不改
  updated_at: number; created_at: number;
}
interface StrategyRevision { strategy_id: string; version: number; at: number; episode_id: string; from_state: StrategyState; to_state: StrategyState; action: Action; reason: string; snapshot: Strategy }

interface Evidence { ref: string; kind: string; label: string; value: string; observed_at: number; source: string; stale: boolean }

interface Judgment {                                  // 模型输出契约(严格校验;失败 → 修一次 → 仍失败 fail-closed NO_TRADE)
  action: Action; direction: Direction | null;
  confidence: number;                                 // 0..1
  headline: string;                                   // ≤ 40 字,一句人话
  thesis: string;                                     // ≤ 200 字
  reasons: string[];                                  // 2-5 条,每条引用 evidence_refs
  evidence_refs: string[];                            // ⊆ registry
  invalidation: string | null; invalidation_price: string | null; target_price: string | null;
  watch_conditions: string[];
  proposal: null | { direction: Direction; entry: 'market'|'limit'; limit_price: string|null; stop_price: string; take_profit_price: string|null; rationale: string }
}

interface Episode {
  id: string; at: number; as_of: number;
  trigger: { kind: 'kline_close'|'manual'|'schedule'|'monitor'|'position_review'; detail: string };
  strategy_before: { state: StrategyState; version: number };
  evidence: Evidence[];
  context_text: string;                               // 模型看到的全文(段 1-8)
  context_hash: string; prompt_version: string; model: string;
  judgment: Judgment | null; judgment_raw: string | null; schema_errors: string[];
  reducer: { from: StrategyState; to: StrategyState; accepted: boolean; reason: string } | null;
  gates: { name: string; passed: boolean; reason: string }[];
  intent: DemoIntent | null;
  usage: { input_tokens: number; output_tokens: number; latency_ms: number; cost_estimate: string } | null;
  status: 'running'|'done'|'failed'; error: string | null;
  strategy_after: { state: StrategyState; version: number } | null;
}

interface DemoIntent {                                // 演示执行记录(不是契约六记录)
  id: string; episode_id: string; at: number; kind: 'open'|'close'|'reduce';
  symbol: string; direction: Direction; quantity: string; entry: 'market'|'limit'; limit_price: string|null;
  stop_price: string|null; take_profit_price: string|null;
  sizing: { equity: string; risk_pct: string; risk_usdt: string; stop_distance: string; raw_qty: string; step_size: string; note: string };
  status: 'pending_approval'|'approved'|'rejected'|'submitted'|'filled'|'failed'|'unknown';
  client_order_id: string | null;
  backend: 'paper'|'demo'; receipts: unknown[]; error: string | null;
}

interface AccountView { backend: 'paper'|'demo'; equity: string; available: string; unrealized_pnl: string; positions: { symbol: string; side: Direction; qty: string; entry_price: string; mark_price: string; unrealized_pnl: string; leverage: number }[]; open_orders: { client_order_id: string; type: string; side: string; qty: string; price: string|null; stop_price: string|null; reduce_only: boolean; status: string }[]; as_of: number }
interface MarketView { symbol: string; last: string; mark: string; funding_rate: string; next_funding_at: number; open_interest: string; as_of: number; klines_tf: string }
interface LoopView { running: boolean; paused: boolean; halted: boolean; every_ms: number; next_at: number | null; last_episode_id: string | null; brain: string; backend: 'paper'|'demo'; auto_approve: boolean }
```

## 3. HTTP API(gateway,`/api/*`,全部 JSON;错误 `{error:{code,message}}`)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | `{ loop: LoopView, strategy: Strategy, account: AccountView, market: MarketView, recent_episodes: EpisodeSummary[] }` |
| GET | `/api/episodes?limit=50&before=<id>` | `EpisodeSummary[]`:`{id, at, trigger, action, direction, headline, confidence, from_state, to_state, has_intent, status}` |
| GET | `/api/episodes/:id` | 完整 `Episode`(回放用) |
| GET | `/api/strategy` | `Strategy` + `revisions: StrategyRevision[]` |
| GET | `/api/intents?limit=50` | `DemoIntent[]` |
| GET | `/api/market/klines?tf=1h&limit=300` | `{tf, klines: [{open_time, open, high, low, close, volume, close_time}]}` |
| GET | `/api/logs?limit=200` | `{ logs: [{at, level, scope, message, data?}] }` 系统日志(人话) |
| POST | `/api/run-now` | 立刻起一个 episode(trigger=manual);返回 `{episode_id}`;正在跑则 409 |
| POST | `/api/pause` / `/api/resume` | 暂停/恢复调度(暂停期间不调模型) |
| POST | `/api/halt` | body `{confirm:'HALT'}`;撤所有挂单 + 市价平仓(paper/demo)+ halted=true,之后拒绝一切开仓;`/api/resume` 解除 halted 需 body `{confirm:'RESUME'}` |
| POST | `/api/settings` | body `{auto_approve?: boolean, every_ms?: number}` |
| POST | `/api/intents/:id/approve` / `reject` | 手动审批模式下使用 |
| GET | `/api/events` | **SSE**:`event:` 之一 `loop.state`(LoopView)/`episode.started`({id,trigger})/`episode.finished`(EpisodeSummary)/`strategy.changed`(Strategy)/`intent.changed`(DemoIntent)/`account.updated`(AccountView)/`market.tick`(MarketView)/`log`(log 行);`data:` 为 JSON;每 15s 一条 `: ping` |

## 4. tswarm-demo-exec NDJSON 协议(gateway ↔ Rust,stdin 请求一行,stdout 响应一行)

请求 `{"id":<int>,"op":"<op>","params":{...}}`;响应 `{"id":<int>,"ok":true,"result":<json>}` 或 `{"id":<int>,"ok":false,"error":{"kind":"<local_reject|unauthorized|clock_skew|rate_limited|transport|rejected>","message":"…","code":<int?>,"ambiguous":<bool>}}`。启动后先自发一行 `{"id":0,"ok":true,"result":{"hello":"tswarm-demo-exec","base_url":"https://demo-fapi.binance.com","api_key_masked":"…","server_time_offset_ms":…}}`。stderr 是日志。

| op | params | result |
|---|---|---|
| `ping` | — | `{server_time, offset_ms}` |
| `account` | — | fapi `/fapi/v3/account`(或 v2)原样 |
| `balance` | — | `/fapi/v3/balance` 原样 |
| `positions` | `{symbol?}` | `/fapi/v2/positionRisk` 原样 |
| `open_orders` | `{symbol?}` | 原样 |
| `symbol_rules` | `{symbol}` | `{step_size, tick_size, min_qty, min_notional, price_precision, qty_precision}` |
| `mark_price` | `{symbol}` | premiumIndex 原样 |
| `set_leverage` | `{symbol, leverage}` | 原样 |
| `place` | `NewOrderRequest`(serde 形状,**`new_client_order_id` 必填**,否则 local_reject) | 下单回执原样 |
| `get_order` | `{symbol, client_order_id}` | 原样 |
| `cancel` | `{symbol, client_order_id}` | 原样 |
| `cancel_all` | `{symbol}` | `DELETE /fapi/v1/allOpenOrders` 原样 |
| `close_position` | `{symbol}` | 读 positionRisk,若有仓位则市价 reduceOnly 反向单(`new_client_order_id` 由 gateway 传入 `params.client_order_id`),返回 `{closed: bool, receipt?}` |
| `set_margin_type` | `{symbol, margin_type: "cross"\|"isolated"}` | `POST /fapi/v1/marginType`(映射成 `CROSSED`/`ISOLATED`)原样;已经是目标模式时币安回 -4046,按成功处理成 `{unchanged:true}` 而不是错误 |
| `all_orders` | `{symbol, limit?}` | `GET /fapi/v1/allOrders` 原样(含已终态历史单);`limit` 默认 50 |
| `user_trades` | `{symbol, limit?, start_time?}` | `GET /fapi/v1/userTrades` 原样(成交明细);`limit` 默认 50 |
| `income` | `{symbol?, income_type?, limit?, start_time?}` | `GET /fapi/v1/income` 原样(资金流水,读 `REALIZED_PNL` 等);`limit` 默认 100 |
| `exchange_info_symbols` | `{}` | 从 `/fapi/v1/exchangeInfo` 抽取,只留 `contractType=="PERPETUAL"` 且 `quoteAsset=="USDT"` 的行,紧凑数组 `[{symbol, status, price_precision, qty_precision, step_size, tick_size, min_qty, min_notional}]`(给符号选择器用,~500 行) |
| `leverage_bracket` | `{symbol}` | `GET /fapi/v1/leverageBracket` 原样(杠杆分层/维持保证金率) |

硬规则:base URL 只能是 `FAPI_DEMO`;凭证只从 `~/.trading-swarm/secrets/apikey-demo.json` 或 env `TG_DEMO_API_KEY`/`TG_DEMO_API_SECRET` 读;不实现任何 sapi/划转/提币;`place` 的 `new_client_order_id` 缺失直接拒;transport 类错误的响应 `ambiguous=true`(发送后不确定),gateway 据此标 `unknown` 并用 `get_order` 对账,**不重发**。

## 5. 判断循环(gateway)

1. 触发:默认「`timeframe` K 线收盘后 5 秒」+ 手动;paused 时只采行情不调模型;halted 时只允许 `REDUCE/EXIT` 语义(实际上不再调模型)。
2. EpisodeBuilder:拉 `klines(1h×120, 4h×60, 15m×40)`、premiumIndex、openInterest、24h ticker;算结构特征(近 20/50 根高低点、EMA20/50、ATR14、距离最近高低点 %、成交量相对、funding、OI 变化);账户视图;当前 Strategy。全部注册为 `E1..En`(带 observed_at / source / stale)。
   - v4(`demo-playbook-v4`)起,判断链上摇摆最厉害的两个分界由代码算好、各登记成一条证据(`demo/review-metrics.ts`):扫描给 `kind:'checklist'`「扫描清单」(ATR% vs 0.4%、1h/4h 是否同向、距 20 根高/低几个 ATR、回踩是否确认、量比,末尾 `watch_eligible=是/否`),复查给 `kind:'position'`「持仓/挂单度量」(每张风险=1R、浮盈 R 与 %、距止损 R 与 %、第一止盈 R、持有根数/分钟、最近一根收盘是否越过止损或失效价、是否在入场区、结构是否转弱)。system 提示的硬红线 7、8 就是拿这两条证据判 WATCH/NO_TRADE 与 HOLD/EXIT/REDUCE 的分界,模型只读不算——理由见 `docs/eval/results-2026-09-04.md`「v4:边界规则化」。
3. ContextBuilder:段 1 Policy(身份+红线+输出契约)/ 段 2 Playbook(一个突破-回踩策略)/ 段 4 市场 / 段 5 账户 / 段 6 触发 / 段 7 当前策略与上次判断摘要 / 段 8 任务+选项复述+`now`。总量 ≤ 3.5k tokens。`context_hash = sha256(context_text)`。
4. 大脑:`pi -p --no-tools --no-session --no-extensions --no-skills --no-context-files --thinking off --mode json`(zai/glm-5.3,默认)或 `claude -p --output-format json --json-schema`(strong);从输出里抽 JSON → zod 校验 → 失败带错误修一次 → 仍失败 `NO_TRADE(reason=schema_invalid)`。
5. Reducer(纯函数,`reduce(strategy, judgment, account)`):按状态表决定是否接受迁移;`PROPOSE` 只在无持仓时接受(任何非持仓状态都可以,刚平仓 10 分钟内除外);`ADD/REDUCE/EXIT/HOLD` 只在有持仓时接受;不接受的动作记 `reducer.accepted=false` 并保持原状态。
6. Gates(代码):halted / paused / 有持仓不许再 PROPOSE / stop 距离 ≥ 0.3% 且 ≤ 5% / 单笔风险 = 权益 × `risk_budget_pct`(默认 0.5%)/ 名义 ≤ 权益 × 3 / 每日最多 2 次开仓 / evidence_refs 全在 registry 内 / stale 证据不许支撑 PROPOSE。
7. Sizing(代码):`qty = risk_usdt / stop_distance`,按 step_size 向下取整,再受名义上限钳制。
8. 执行:`auto_approve=true`(demo 默认)→ 直接提交;否则挂 `pending_approval` 等 UI 点。paper:按 mark 成交,保护单本地挂(tick 里检查触发)。demo:`place`(entry)→ 成功后 `place`(STOP_MARKET reduceOnly)→ 可选 `TAKE_PROFIT_MARKET`;任一保护腿失败 → 立刻 `close_position` 补偿并记 log(裸仓不过 30 秒)。
   - paper 落库:`PaperBackend` 每次状态变更(下单/成交/撤单/止损止盈触发/设杠杆/推 mark)后把整份 `PaperSnapshot`(version + wallet + positions + open orders + closed orders + marks + leverages)写进 `demo_kv` 的 `paper_state` 行,启动时读回并校验 `version`(不匹配只 warn 后从零开始)。所以重启后纸面持仓与挂单还在,线程不会被误判成「交易所侧已平」。demo/cli 后端状态在交易所侧,不接这个快照。
9. 回放:Episode 全量落 `state.sqlite`(表 `demo_episodes/demo_strategies/demo_strategy_revisions/demo_intents/demo_logs`),UI 的详情页就是回放。

## 6. 怎么跑

```
./start-demo.sh                     # gateway 18800 + webui 5180;有 demo key 走 Binance Demo Trading,否则纸面
TG_DEMO_BRAIN=stub ./start-demo.sh  # 不调模型(桩大脑,永远 NO_TRADE)
TG_DEMO_BRAIN=claude ./start-demo.sh # 用 Claude Code 订阅当大脑(耗额度)
```
demo key:https://demo.binance.com → API 管理 → 建 key → 写 `~/.trading-swarm/secrets/apikey-demo.json`(`{"api_key":"…","api_secret":"…"}`,`chmod 600`)。不要用主账户 key。

## 7. 实测记录

- 2026-09-03 paper + 桩大脑:PROPOSE → 市价入场 0.064 BTC @ 77674.9 → 止损 76898.2 / 止盈 79228.4 挂出 → 策略 active(v2)→ 持仓复查 HOLD → 紧急停:撤单 + 平仓,权益 9996.02(两笔手续费)→ 解除需 `confirm=RESUME`。
- 2026-09-03 paper + GLM-5.3(经 pi):WATCH,「大小周期方向冲突,价格贴近20根高点,先观望」,引用 E5/E6/E7,880 入 / 234 出 token,17 s,≈¥0.006;reducer researching → watching。
- demo-fapi 真实下单:**未测**(等 demo key)。
