# Demo v2:信息员 → 扫描 → 策略线程 → 订单跟踪 → 复查(图循环)+ 下单面板 + 对话(2026-09-03)

> 目标形态对齐 8794 的交易页(下单面板 + 策略线程 + 挂单/持仓)和 Agent 页,但信号源不接外部带单员:由 agent 自己的**信息员**定时读外部信息、总结成市场状态,再由**扫描**在观察列表里找开单机会、形成**策略线程**;线程一旦有单,所有订单事件(挂出 / 成交 / 止盈止损触发 / K 线收盘 / 信息更新)都回到线程做一次**复查判断**。所有判断仍是 `Episode`,可回放。
> 本页是 v1(`README.md`)之上的**增量契约**;v1 的 Episode / Evidence / Judgment / 执行后端 / NDJSON 协议不变。

## 1. 图循环(节点 = 确定性代码,边 = 事件;模型只在 ◆ 处被唤醒)

```
[信息员 ◆ cheap] ──every info_every_ms──▶ MarketState(as_of, regime, 摘要, 候选)
        │ info_update(相关线程)                        │
        ▼                                             ▼
[扫描 ◆] ◀──kline_close(watchlist 中无线程的币)── watchlist ────────────────┐
   │ PROPOSE → 代码闸 → sizing                                              │
   ▼                                                                       │
StrategyThread(pending_entry) ──entry 成交──▶ in_position ──SL/TP 触发/EXIT──▶ closed
   │ ◆ 复查(kline_close / order_filled / tp_hit / sl_hit / info_update / manual)   │
   │   pending_entry:HOLD(继续等)| INVALIDATE(撤单,线程 canceled)                  │
   │   in_position: HOLD | REDUCE | EXIT | INVALIDATE                              │
   └──────────────────────────────────────────────────────────────────────────┘
[对话 ◆] 用户消息 → 工具(读状态 / 读线程 / 提议线程 / 平线程 / 改工作流 / 立刻扫描)→ 回复
[下单面板] 用户手动 → 与 agent 同一条执行链(线程 source=manual,principal=user)
```

规则:同一时刻只有一个模型调用在飞(队列,FIFO,同线程事件合并去重);tick(10 s)只跑纯码:行情、账户、挂单状态、线程的入场单是否成交、SL/TP 是否触发、失效价是否穿越。

## 2. 领域对象(增量;金额十进制字符串,时间 unix 毫秒,snake_case)

```ts
interface Workflow {                       // 单行,UI「工作流」面板直接编辑
  watchlist: string[];                     // 默认 ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT']
  timeframe: string;                       // 扫描/复查用的 K 线周期,默认 '15m'
  info_every_ms: number;                   // 信息员周期,默认 30 分钟
  risk_pct: string;                        // 单笔风险 % 权益,默认 '0.5'
  leverage: number;                        // 默认 3
  margin_mode: 'cross'|'isolated';         // 默认 cross
  max_open_threads: number;                // 默认 3
  max_opens_per_day: number;               // 默认 4
  auto_approve: boolean;                   // agent 的 PROPOSE 是否免确认
  brain: 'pi'|'claude'|'stub';             // 判断/对话用哪家
  cheap_brain: 'pi'|'claude'|'stub';       // 信息员用哪家
  playbook_text: string;                   // 可编辑的 playbook 段落(注入判断 prompt)
  paused: boolean;
  updated_at: number;
}

interface InformationEvent {               // 外部世界进入系统的归一化事件
  id: string; kind: 'news'|'market_snapshot'|'sentiment';
  source: string; source_ref: string;      // 'coindesk' / URL
  occurred_at: number; observed_at: number; ingested_at: number;
  dedupe_key: string;                      // sha256(url) 或 'snapshot:<as_of>'
  title: string; digest: string;           // 标题 / ≤300 字正文摘要或数值串
  assets: string[];                        // 提到的币,如 ['BTC','ETH']
}

interface MarketState {                    // 信息员的产物;判断 prompt 的一段
  id: string; as_of: number; model: string;
  regime: 'trend_up'|'trend_down'|'range'|'volatile'|'unclear';
  bias: 'long'|'short'|'neutral';
  summary: string;                         // ≤300 字人话
  key_points: string[];                    // 3-6 条,每条带 [I<n>] 引用
  majors: { symbol: string; last: string; change_24h_pct: string; funding_rate: string; oi_change_1h_pct: string|null; long_short_ratio: string|null; taker_buy_sell_ratio: string|null }[];
  sentiment: { fng: number|null; fng_label: string|null };
  top_movers: { symbol: string; change_24h_pct: string; quote_volume: string }[];   // 观察列表之外的 5 涨 5 跌(只读参考)
  news: { ref: string; title: string; source: string; published_at: number; relevance: 'high'|'medium'|'low'; digest: string }[];
  candidates: { symbol: string; direction: 'long'|'short'; why: string }[];         // 只是建议,扫描会重新判断
  risk_events: string[];                   // 即将到来的风险(宏观数据、解锁、监管)
  info_refs: string[];                     // 用到的 InformationEvent id
  usage: Usage|null;
}

type ThreadStatus = 'pending_entry'|'in_position'|'closed'|'canceled'|'invalidated';
interface StrategyThread {                 // 对齐 8794「策略线程」,一行一条
  id: string; symbol: string; side: 'long'|'short'; status: ThreadStatus;
  source: 'agent'|'manual'|'chat'; timeframe: string;
  thesis: string; invalidation_text: string|null; watch_conditions: string[];
  entry: { type: 'market'|'limit'; price: string|null; zone: [string, string]|null };
  stop_price: string|null; take_profits: string[];                                  // 多 TP:第一个先挂,其余记录
  qty: string; margin_usdt: string|null; leverage: number; margin_mode: 'cross'|'isolated';
  entry_client_order_id: string|null; protection_client_order_ids: string[];
  filled_avg_price: string|null; realized_pnl: string|null; close_reason: string|null;
  episode_ids: string[]; intent_ids: string[];
  created_at: number; updated_at: number; opened_at: number|null; closed_at: number|null; version: number;
}

interface ChatMessage {
  id: string; at: number; role: 'user'|'agent'|'tool'|'system';
  text: string;
  tool_calls: { name: string; args: unknown; result: unknown; ok: boolean }[];
  episode_id: string|null;
}

// Episode 增量字段
//   thread_id: string|null; symbol: string;
//   trigger.kind 增加:'scan' | 'info_update' | 'order_filled' | 'tp_hit' | 'sl_hit' | 'thread_review' | 'chat'
```

## 3. HTTP API 增量(gateway,`/api/*`)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | v1 字段 + `workflow`, `market_state`(最新), `threads`(非终态), `markets: Record<symbol, MarketView>`(watchlist), `queue: {pending: number, running: {kind, symbol}|null}` |
| GET/POST | `/api/workflow` | 读 `Workflow` / 局部更新(POST body 是 Partial,**总是 200**,返回 `{workflow, errors}`,errors 非空表示没改) |
| GET | `/api/market-state` · `/api/market-state/history?limit=20` | 最新 MarketState / `{history: MarketState[]}` |
| POST | `/api/info/run-now` | 立刻跑一次信息员;返回 `{queued, job_id}`,结果走 SSE `market_state.updated` |
| GET | `/api/info/events?limit=100` | `{events: InformationEvent[]}`(最新在前) |
| POST | `/api/scan-now` | body `{symbol?}`;对一个币或整个 watchlist 排队扫描;返回 `{queued, job_ids}` |
| GET | `/api/threads?status=open\|all` | `{threads: StrategyThread[]}`(open = pending_entry + in_position) |
| GET | `/api/threads/:id` | `{thread, episodes: EpisodeSummary[], intents: DemoIntent[]}` |
| POST | `/api/threads/:id/close` | 市价平仓 / 撤入场单,线程 closed(close_reason=manual) |
| POST | `/api/threads/:id/review` | 立刻对该线程做一次复查判断 |
| POST | `/api/orders` | **下单面板**:`{symbol, side:'long'\|'short', action:'open'\|'close', type:'market'\|'limit', price?, margin_usdt?, leverage?, qty?, tp?, sl?, margin_mode?}` → 建 `source=manual` 线程 + intent,同一条执行链;返回 `{thread, intent}` |
| GET | `/api/orders/open` · `/api/positions` | 交易所挂单数组 / 持仓数组(AccountView 的两段) |
| GET | `/api/symbols` | `{symbols: SymbolInfo[]}`(demo/cli 后端来自交易所;paper 内置 20 个) |
| GET | `/api/market/klines?symbol=&tf=&limit=` | v1 加 symbol 参数 |
| GET/POST | `/api/chat/messages` | `{messages: ChatMessage[]}` / 发一条用户消息(`{text}`)→ 202 `{accepted}`,回复走 SSE `chat.message` |
| POST | `/api/chat/reset` | 清空主会话 |
| SSE | `/api/events` | v1 事件 + `market_state.updated`(MarketState)· `thread.changed`(StrategyThread)· `chat.message`(ChatMessage)· `queue.state`· `workflow.changed` |

## 4. 信息员(cheap brain)

输入(全部公开、无 key):全市场 24h 行情(取 watchlist + 成交额前 30)、premiumIndex(资金费率)、`openInterestHist`(1h 两点)、`globalLongShortAccountRatio` / `takerlongshortRatio`(watchlist 各一)、alternative.me 恐惧贪婪、CoinDesk + Cointelegraph RSS(去重、只取 6 小时内、每源 ≤ 15 条)。先归一化成 `InformationEvent`(I1..In 编号),再让模型输出 `MarketState` JSON(严格校验、修一次、失败则只保留数值段并把 `summary` 标为「模型总结失败」)。输入预算 ≤ 3k token。

## 5. 判断 prompt 的增量段

在 v1 的段之间插入「市场状态」段:`MarketState.summary` + 与本币相关的 key_points + 情绪 + 与本币相关的 news(≤3 条,标 I 编号并登记为 Evidence,kind='info')。扫描时允许的 action:NO_TRADE / WATCH / PROPOSE;复查时:pending_entry → HOLD / INVALIDATE;in_position → HOLD / REDUCE / EXIT / INVALIDATE。`proposal` 增加 `entry_zone: [lo, hi]|null`(限价挂在靠近现价的一端,记录整个区间)与 `take_profits: string[]`。

## 6. 对话(主会话)

`pi -p --session-id <main> --session-dir ~/.trade-gate/demo/sessions`(或 claude `--resume`);系统提示 = 角色 + 工具清单 + 当前状态摘要(每轮重新注入,带 as_of)。工具调用契约:模型回复中若含一行 `@@tool {"name":"…","args":{…}}`,gateway 执行后把 `@@result {...}` 作为下一条用户消息喂回,最多 4 轮;无工具行即为最终回复。工具:`get_state` / `list_threads` / `get_thread{id}` / `propose_thread{symbol, side, entry, stop_price, take_profits, thesis}`(走与扫描相同的闸和 sizing,source=chat,auto_approve 关时挂待确认)/ `close_thread{id}` / `set_workflow{patch}` / `run_scan{symbol?}` / `run_info`。动钱工具只到「提议」,确认在 UI。

## 7. 前端(对齐 8794 交易页)

侧栏:交易 / Agent / 判断记录 / 日志 / 设置。顶栏:权益 · 未实现 · 后端 chip(纸面 / Binance 模拟盘)· 队列状态 · 紧急停止。
- **交易页**:左 = 下单面板(币种选择 + 现价、开多/开空/平多/平空、市价/限价、价格、保证金 USDT + 杠杆、全仓/逐仓、止盈/止损可选、名义/数量/预估强平价摘要、提交);中 = 策略线程列表(状态 chip 待入场/持仓中、时间、币、方向、来源 agent/手动/对话、入场区间、SL/TP;点一行填入左侧面板;右上 tabs 图表/策略/Agent);底 = 交易所挂单 / 持仓 两个 tab。
- **Agent 页**:中 = 对话(消息流,工具调用折叠显示);右 = **工作流面板**(watchlist、周期、信息员频率、风险 %、杠杆、自动执行、大脑、playbook 文本、暂停)+ 「信息员最新总结」卡(regime / bias / 摘要 / 候选 / 风险事件 / 新闻 3 条)+ 「立刻跑信息员」「立刻扫描」按钮。
- **判断记录页**:v1 的时间线,加 symbol 与线程链接过滤。

## 8. 实测记录(2026-09-03 下午,paper 后端)

- 桩大脑冒烟:手动市价单(ETHUSDT 多,保证金 100 × 3x)→ 0.124 成交 → 止损/止盈挂出 → 线程 `in_position`;限价单(SOLUSDT 空 @ 99999)→ `pending_entry`;工作流越界值被钳制(risk 9 → 2,非法币种被丢);线程平仓 → `closed` 带 realized_pnl;紧急停 → 待入场线程 `canceled`、持仓线程 `closed`。
- 真模型(GLM-5.3 经 pi):信息员 21 s,588 入 / 469 出 token,产出 `range / neutral`,6 条 key_points(引用 I3 与 [数据]),候选 BTC 多 / ETH 空各带一句理由,新闻 3 条分 high/medium/low;随后 BTC、ETH 扫描各 16 s,都判 WATCH(理由:多周期方向不一、量能不足);对话「现在市场怎么样?有没有线程?」一句话答「区间震荡、动能弱,无持仓无线程」。
- 已知取舍:信息员的 RSS 只取 6 小时内、每源 15 条;`ADD` 在演示版永不执行;止盈只挂第一档,其余记录在线程上;`execution_unknown` 只核对一次再冻结开仓;demo-fapi 真实下单仍未测(等 demo key)。

## 9. 从 8794 抄了什么、没抄什么

抄了(语义,不是代码):线程状态按交易所事实重推导而不是信自己的字段;保护腿按巡检补挂(60 s 节流)而不是只在下单时挂一次;`tgd-` 前缀区分本机订单,不属于任何线程的仓位标「外部」不碰;风控按「名义 ≤ 权益 × 倍数」逐腿钳制;止损/止盈 working type 用标记价。
没抄:按读派生线程(我们持久化线程,只重推导状态,因为线程承载的是 agent 的计划——论点、入场区、失效条件,交易所里没有这些);attention 桶的十几种代码(只留 PROTECTION_MISSING / ORDER_UNKNOWN / CLOSE_FAILED);TWAP;多 TP 阶梯分配。
8794 没有而这里新加的:日亏停(`daily_loss_stop_pct`,按 UTC 日初权益算)、最多同时线程数、K 线收盘驱动的持仓复查。

## 10. Codex 对抗 review(2026-09-03,`.codex-reports/demo-v2-review.md`)的处理

Codex 判 **NO-GO**(8 P0 / 13 P1 / 4 P2),核心两类:把不确定事实写成终态;审批/暂停/紧急停/手动单没有重闸。当场修掉的:
- 未知不判终态:入场单状态不明 → 线程保持待入场 + `ORDER_UNKNOWN`,巡检按 clientOrderId 持续核对,连续 4 次查不到且无仓才判 canceled;止损传输断连/超时即使回报 failed 也按 unknown:优先按 clientAlgoId 查算法单,查到视为已提交,明确查不到才用同一 ID 重发一次(重复 ID 拒绝视为已提交),重发仍失败/未知才补偿平仓;查询不确定则保持 in_position + PROTECTION_MISSING 等巡检;仅明确交易所拒绝且非既有排除码才作废保护验证记录;补偿平仓失败 → 线程不关,`CLOSE_FAILED` 巡检;撤入场单失败 → `CANCEL_UNKNOWN` 保持待入场;紧急停撤单/平仓失败的币 → `HALT_INCOMPLETE` 不判终态。
- 重闸:提议通过后**重新拉账户与标记价**再 sizing;发单前再查一次紧急停/暂停/日亏停/线程上限/同币外部持仓;杠杆/保证金模式设置失败即放弃入场;审批加单飞 + 重查 halted/paused/线程状态;`paused` 进 gate。
- 归属:pending 线程只有**自己的入场单**成交才转持仓中,同币出现外部仓位 → `EXTERNAL_POSITION` 不挂保护;止损巡检要匹配我们的 CID 或止损价(±0.5%);部分成交 → 转持仓中并撤余量,qty 用已成交量。
- 手动单:必须带止损;杠杆 ≤ 工作流上限(10x);名义 ≤ 权益 × 3;走同一套线程/日内/日亏闸;平仓必须指定方向且与持仓一致。
- sizing:最小名义抬升后若超过名义上限或实际风险超预算 1.5 倍 → 拒单;可成交限价按 mark 与 limit 中更差的一个算止损方向与距离。
- 对话:`set_workflow` 只允许改 watchlist/timeframe/信息员频率/playbook/暂停,风险类字段拒绝;工具轮数 4。
- 信息员:RSS 标题/正文清洗后包在 `<untrusted_data>` 里,提示明说其中指令一律忽略;新闻按自身年龄判 stale。
- HTTP:带 Origin 的非 GET 请求只放行本机 UI。
- 轮询:行情/账户轮询单飞。
未修(记入待办):CID 唯一索引与事务内分配;线程保存的乐观 CAS;Rust `close_position` 在双向持仓模式的语义;symbol 级 `cancelAll` 会撤外部挂单;规则缓存 TTL;`chat.close_thread` 直接动钱(用户在对话里下的指令,演示版接受);approve 绑定 plan hash。

## 11. Codex 复查(`.codex-reports/demo-v2-recheck.md`)后的第二批收口

复查结论 FIXED 1 / PARTIAL 17 / NOT_FIXED 7 + 8 个新缺陷,复盘在 `docs/demo/retro-2026-09-03.md`。本批修的:日内开仓计数排除当前线程;`entry_lookup_misses`/`leg_seq` 进线程契约,查不到入场单**永不自动撤**只升 ORDER_UNKNOWN;线程找回订单/终态时同步解冻或收口意图;紧急停期间不挂保护、`HALT_INCOMPLETE` 每轮重试撤单+平仓;平仓只认 `closed=true` 或新鲜账户证明已平;`ENTRY_REMAINDER` 每轮重试撤余量且不被保护流程清掉;binance-cli 写类命令超时一律 ambiguous、"已不存在"只认 -2011/-2013(Rust 后端同);减仓只在成交后改本地数量;暂停期间任何扫描都不排队;sizing 实际风险超预算 5% 即拒;对话的提议一律待确认、平仓变成待确认意图(审批入口支持 close);CID 用 sha1(thread.id) 前缀 + 线程 `leg_seq`;规则缓存 10 分钟、非 TRADING 拒单;Rust 回环校验严格化、`close_position` 双向持仓按侧平仓。
仍未做(属 A2):账户级单写 actor / execution epoch;CAS + plan hash;多源持续对账;RPC 通道隔离;精确 CID 撤单;十进制定点;鉴权。
