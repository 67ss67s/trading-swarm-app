# @trade-gate/gateway

TS network/control-plane process. **A0 scope** (see `docs/design/trade-gate-design-v1-2026-09-02.md`
§15.1): just the two pieces everything else in the gateway will sit on top of —

- `src/exec-client.ts` — `ExecClient`, the UDS JSON-RPC client for execd (the only thing in this
  process allowed to talk to execd; see AGENTS.md rule 1 — no exchange credentials or direct
  exchange connections belong anywhere in `packages/gateway`).
- `src/state-db.ts` — `openStateDb`, gateway's own `state.sqlite` (schema + migrator + the
  `events`/`kv` DAOs actually needed right now; every other table from
  docs/contracts/README.md §9 exists as schema only).

Nothing here reads or writes `exec.sqlite` (execd's own database) or exchange credentials.

## `ExecClient`

```ts
import { ExecClient } from '@trade-gate/gateway';

const client = new ExecClient(); // socketPath defaults to ~/.trade-gate/run/execd.sock
const health = await client.call('exec.health', {});
const sub = client.subscribe(0, (event) => console.log(event.event, event.seq));
// ...
sub.unsubscribe();
client.close();
```

- `call(method, params, {timeoutMs?})` — typed per method via `ExecMethods` (from
  `@trade-gate/contracts`); default 10s, 30s for `exec.account.snapshot`
  (docs/contracts/README.md §8). Rejects with `ExecRpcError` (code/kind/retryable/details) on a
  JSON-RPC error frame, or **`ExecTimeout`** if nothing came back in time.
- **A timeout is not a failure.** For a write method (`exec.intent.propose`,
  `exec.intent.authorize`, ...), execd may have already committed the effect before the response
  was lost. Catching `ExecTimeout` on a write means: call `exec.intent.get` (matched by the
  intent/idempotency key you sent) before deciding whether to retry or surface a failure — see
  `ExecTimeout`'s doc comment in `exec-client.ts`. Read methods can typically just be retried.
- `subscribe(sinceSeq, onEvent)` — delivers `exec.event` notifications in strict seq order;
  duplicates and out-of-order arrivals are dropped and counted (`handle.stats()`), never
  buffered/reordered. Survives reconnects by re-issuing `exec.events.subscribe` with the last
  delivered seq once the socket comes back (execd backfills the gap). One subscription per client.
- Reconnects automatically on disconnect with exponential backoff (`minReconnectDelayMs` →
  `maxReconnectDelayMs`, default 250ms → 10s); calls made while disconnected queue and send once
  reconnected, same as calls made before the very first connect completes.
- `client.connected` is true only once the socket's own `'connect'` event has fired — not merely
  "a socket object exists," which is true well before the handshake completes (see the getter's
  doc comment if you're tempted to poll this for anything timing-sensitive: the *server* seeing
  the connection is a separate, independently-ordered event).

## `openStateDb`

```ts
import { openStateDb } from '@trade-gate/gateway';

const db = openStateDb('/path/to/state.sqlite'); // creates the file + runs migrations if needed
db.appendEvent({ event: 'run.started', at: Date.now(), source: 'gateway', json: '{}' });
const recent = db.eventsSince(0);
db.kvSet('policy_version', '3');
db.close();
```

`node:sqlite`'s `DatabaseSync`, WAL journal mode, `foreign_keys=ON`, `busy_timeout=5000`. Migrations
live in `src/migrations/*.sql` (currently just `0001_init.sql`), tracked in `schema_migrations`,
applied one file per transaction, idempotent — re-opening an already-migrated database is a no-op.
Add a new numbered file for further schema changes; don't edit a shipped one (the migrator keys
off the filename, so an edited-in-place file silently never re-runs against existing databases).

`db.db` is the raw `DatabaseSync` handle, for anything beyond the three DAO methods
(`appendEvent`/`eventsSince`/`kvGet`/`kvSet`) this package provides today.

## Tests

```
npm run test
```

`test/helpers/fake-execd.ts` is a minimal hand-rolled NDJSON JSON-RPC server (not a mock of
execd's actual business logic — just enough wire protocol to drive `ExecClient` from the outside)
used by `test/exec-client.test.ts` to cover request/response correlation, `ExecTimeout`, in-order
event delivery with duplicate/out-of-order counting, reconnect-and-resubscribe, and oversized
frames. It listens on a short `/tmp/tg-t-<random>.sock` path — UDS paths are capped at 104 bytes on
macOS, which this session's own scratch directory does not fit under, so tests never use it for
sockets. `test/state-db.test.ts` covers the migrator (including idempotency) and the DAOs against
a temp-directory sqlite file per test.

## Agent 辅助仓位

`demo/sizing-agent.ts` 使用 cheap brain 提供有界意见；`demo/gates.ts` 计算数量并执行名义/流动性上限，组合硬闸仍只拒不改。默认 `workflow.sizing_agent=advise`，详见 `docs/design/sizing-agent-2026-09-07.md`。离线验证：`npx vitest run`（stub brains + 本地假行情）、`npx tsc -b`。

### 持仓动作闸与 Book shadow（holding-v1）

`src/demo/holding-policy.ts` 为入场冻结周期、ATR尺度、结构失效价和成本后RR；runtime 在下单前拒绝不合格计划，在复查执行前重新检验动作。单根急针只提供形态证据；硬止损仍有优先级。已有线程在下次复查建立明确标记的旧仓快照，不改原保护价格或数量。`GET /api/overview` 的 `holding_policy` 可核对部署版本。当前仍为首目标全平，不宣称第二目标会自动执行。

`src/demo/book-policy.ts` 是仓位/杠杆的纯函数 shadow：新提案的 `episode.book_shadow` 留下候选数量与最低足够杠杆，不替换实际执行数量。市场状态和资金费预算目前是显式假设，策略健康尚为 unknown。测试：`npx vitest run test/demo/holding-policy.test.ts test/demo/book-policy.test.ts`。

### P5b 事件订阅与一手研究

`evidence.events` 中普通触发种类保持与 `trigger.kinds` 取交集；`cpi/fomc/unlock` 等事件 subkind 则显式订阅对应的 `event` 入口，仍遵守最小周期。事件事实来自 `EventStore.liveFor`，判断前复核资产、时间窗口和撤销状态。判断的 `trigger.hits` 与触发证据保存事件 ID、subkind、来源 URL、研究任务 ID。`vol_spike` 同名时可匹配普通触发和派生事件，两种来源仍由 `kind` 区分。

事件简报由 `research` 任务产出，任务详情保留来源正文摘录与 refs；旧统计 brief 仅保留历史，不作为一手简报注入。自动研究为 T−24h 预研和 T+2m 发布核对，预算按任务持久化，不能再把 brief 数当模型调用数。离线回归：`npx vitest run test/demo/calendar-feed.test.ts test/demo/events-http.test.ts test/demo/strategies.test.ts test/demo/strategy-loop.test.ts`。官方逐条核对结果见仓库 `.codex-reports/event-research.md` 的 P5b 段。
### P1b 策略采样与成绩隔离（2026-09-12）

`shadow-scheduler.ts` 每分钟独立采集零模型策略信号，使用策略自己的周期、horizon、SignalFn 与 outcome 成本。它不使用扫描队列、议会开关、paper 容量或模型预算；停止时等待在途 shadow 任务，禁止关闭后写库。完整闭合且连续的 K 线水位才允许结算，缺口保留待补并退避。

`strategy-loop.ts` 按 backend 的 effective 版本检查健康；降级增加验证代际、清空当前证据，历史线程仍保留。真实 R 只读取同版本/backend 的 `settlement.status=complete` 净结算；旧的缺失/partial 结算不作为成绩。`backtest.ts` 仅对完成且未截断的 run 按 `(id,version,hash)` 写 eval，正常未成交不算成交样本。

shadow 与 Lab 的 `n` 为 4h 行情桶有效样本量，另保留原始数量；期望、CI/DSR 使用簇统计，净回撤合并并发仓位的闭合 K 线清算权益。方向代理与完整代码策略分栏，模型回放另列 eval。Lab 同时检查候选/入选币池的加载失败率，任一超过 20% 不生成可写回统计；manifest 保存候选参数、币池上市/退市代理及缺失明细、原始数据哈希。定时 Lab 禁用参数探针，手动研究仍只按训练窗选择。

测试：根目录 `npm test`（按 workspace 运行）；聚焦 `npm test --workspace @trade-gate/gateway -- test/demo/strategy-p1b.test.ts`。迁移 `0021_shadow_generation.sql` 扩展 shadow 在途唯一键为 backend × generation；通过正常迁移流程加载。

P9 离线预注册研究：根目录 `npm run lab -- fill` 以当前 workflow 币池补齐缓存（curl 使用环境代理，每请求间隔 1s，429/暂时故障指数退避，断点按覆盖区间续拉；不写运行数据库）。`npm run lab -- --study entry` / `--study params` 冻结 180d 窗口复跑，可指定 `--to <unix毫秒>`、`--symbols BTCUSDT,ETHUSDT` 和 `--output <文件>`。公开元数据和默认 JSON 结果在 `~/.trade-gate/demo/research-entry/`；trial 账本复用 `~/.trade-gate/demo/lab-trials.sqlite`；5m 仅补 30d；`--snapshot <已有研究结果.json>` 冻结版本、币池、窗口与 tick 重放。研究采用当前币池，不能解释为无幸存偏差的历史全集。测试 `npm test -w @trade-gate/gateway -- entry-param-study.test.ts`。
## 相对价值离线研究

`pair-signals.ts` 在训练窗拟合冻结的残差模型，`pair-outcome.ts` 计算双腿费用、资金费与不同步压力，`pair-study.ts` 固定三对/五折及拒绝标准。`strategy-signals.ts` 提供独立 `PAIR_SIGNAL_REGISTRY`；单腿注册表对 `relative_value` 返回 null，常规漏斗不可测。不会创建策略/active记录或接入线上议会。

仓库根运行 `npm run lab -- --study pair`；缓存 `~/.trade-gate/research/pair-v1`（可用 `TG_PAIR_CACHE` 指定），缺失公开历史通过脚本的环境代理串行补充。`npx vitest run packages/gateway/test/demo/pair-study.test.ts` 验证拟合、z、双腿费用/资金费和退出。详见 `docs/research/relative-value-study-2026-09-12.md`。

### 交易员语料离线研究

仓库根执行 `npm run lab -- --study traders`：从公开行情缓存生成原文审计、逐条特征、同时间段随机对照、两类确定性策略与人肉初始计划回放；自动重建 `docs/research/trader-study-2026-09-12.md`。首次补数加 `--fill`，可用 `--cache-root /path` 指定独立目录。取数脚本继承环境代理，按秒限速、重试并原子续写；不读运行 `state.sqlite`。价格与原始输入为十进制字符串，内部纯研究数值运算使用 JS number。

`TRADER_SIGNAL_REGISTRY` / `HUMAN_SIGNAL_REGISTRY` 独立于生产 `SIGNAL_REGISTRY`；没有生产 family、active 或晋升写入。参数、观察窗口、执行规则与源文件 hash 进入试验登记。预注册与实际网格不一致即拒绝执行。公开信号数据、修正表、所有剔除原因和数据 hash 位于 `docs/research/data/traders-0912/`。输入含频道原文，提交仅为本地研究归档，不自动发布。

定向测试：`npm exec --workspace packages/gateway -- vitest run src/demo/trader-study.test.ts`（从仓库根执行）；覆盖时区、去重、原文覆盖、前视、缺口、限价、分档止盈、保本及成本。完整验证仍使用根目录 `npm test` 与 `npm run typecheck`。

### 跟单 session(Trader Follow,2026-09-12)

带单员开单 = 触发器,agent 决定跟 / 不跟 / 只当证据。设计 `docs/design/trader-follow-2026-09-12.md`,契约 `docs/demo/v3-ui-contract.md` §9.38。

四个模块各管一段:`trader-signal.ts` 把 bridge 的结构化信号归一化成内部口径(区间/阶梯/市价意图/多档止盈/无止损/原发时间优先 metadata)并管状态机与 `demo_trader_signal` 表;`trader-feed.ts` 是 Signal Bridge 的 Agent Pull 客户端(游标存 kv `follow.cursor`、长轮询、`X-API-Key`/`X-Secret-Token`、自定义 UA、指数退避封顶 60s、坏行进 DLQ);`trader-stats.ts` 每小时拉一次本机 8794 的 `trader-stats` 换成权重三档;`trader-follow.ts` 做三模式分支与管理动作路由。判定全是纯函数,编排通过注入的 `FollowDeps` 调 runtime,所以单测不起 http、不连网、不调模型。

**首发跟单链路不做任何自动的交易所写操作**(`FOLLOW_AUTO_EXECUTION = false`,代码常量,不进设置也不进 API):拉取 → 判定 → 落 `review_only` 就到此为止,下单只发生在人点 `apply` 之后(走既有手动开仓链路,发的是行上那份 `decision.plan`,不重算)。**零写的范围是跟单链路自身**(feed/capture/判定/ingest/resume/信号级巡检);人工 apply 开出的线程 = 普通手动线程,交给既有系统管理(补保护、复查、结束时撤单都是既有行为,不是跟单的承诺),旧的 `origin:'trader:*'` 线程同理。首发**没有 close 端点**,平仓去交易页。gated 仍然照跑 agent 判断 —— 结论写进信号行的 `decision.agent`,是给人的依据。自动路径的代码留在常量后面,靠 `follow-review.test.ts` 那条「零写调用」测试兜底:三模式 × 八种动作 × 补拉/实时/重投/恢复/巡检,backend 写方法调用次数必须是 0。打开它的前置条件见设计 §7 末尾那四条(R3-01/02/03/05)。

出厂 `follow.enabled=false` 且名册为空:关着的时候一个网络请求都不发。凭证**只从 env** `TG_FOLLOW_BRIDGE_KEY` / `TG_FOLLOW_BRIDGE_SECRET` 读 —— 接口没有写入路径(AGENTS.md 第 1 条:TS 侧不持密),`redactSecrets` 把错误正文、DLQ、日志、SSE、HTTP 响应里的凭证形状统一抹掉。对 bridge 只读(拉取 + 游标回执),对 8794 只读一个统计端点。

可靠性上有几条是对抗复审逼出来的,改之前先读注释:游标**只在整页落库成功之后**才 `commitCursor`,处理崩在中间的行留在 inbox(`new`/`triggered`)由下一轮 `resumeInbox` 领回重跑;补拉的目标水位持久化在 kv,追上水位才切实时,`/me` 失败或「只有被过滤记录的空页」都不算补完;管理动作必须回报 `ManagementResult`,没确认成功就落 `review_only` 进人工队列而不是标 `mgmt_applied`;补拉与迟到的管理动作永远不动仓;管理动作只认精确关联(引用命中且唯一、方向一致),否则一律 `mgmt_orphan`;跟单动作与 episode 共用一条串行链,执行前重取线程版本并复检止损单调性。

从 8794 移植的规则都在 `trader-follow.ts` / `trader-signal.ts` 的注释里标了出处:区间取价(空取最大、多取最小,**取的价就是挂的价**)、市价意图按顶着滑点上限的限价下(BTC/ETH 0.3%、其余 0.5%,并且按**滑点上限**那把尺子验收,不走普通限价的 0.05% 激进度闸)、限价距 mark 超 0.55% 拒、重复开仓与 R53 再入场、反向敞口、管理动作与开仓动作物理分离、`add` 不自动执行、止损只自动收紧、保本按**本线程自己的成交成本**算、补拉只许复盘。多档阶梯入场本实现执行不了(线程只有一条入场腿),标 `unsupported` 转人工,不按第一档挂全量。

仓位按 `risk_pct × weight` 算风险,不用带单员自称的保证金比重;`weight` 永远 ≤ `manual_weight`,统计不可用时压到 `min(manual_weight, 0.5)`(故障不许放大风险预算);减仓按 `min(线程认领量, 实仓)` 定量,方向不符不减;止损距离按对自己更不利的入场基准算,免得被 `executeOpen` 发送前那道数量硬闸拒掉自己。

信号行有自己的状态机:`review_only` 是唯一可执行前态,apply 走**条件更新原子领取**(`review_only → applying`,抢不到 409),成功 `applied`、明确失败 `apply_failed`、崩在发送窗口的 `applying` 行由 resume 隔离回 `review_only + needs_reconcile` 且**永不自动重发**。

**第二个信号源:OKX.AI ASP 订阅(2026-09-20,`okx-asp-feed.ts`)。** 本机 `okx-a2a` 守护把订阅到的 ASP 投递写进 `~/.okx-agent-task/sqlite/session-store.sqlite` 的 `pending_gateway_deliveries`(**消费即删的队列**),`OkxAspFeed` 用 `node:sqlite` 只读轮询(库路径按候选列表探测,WAL 只读打不开就快照一份再读),对 `content`/`llm_content`/`payload_json` 各扫一遍「顶层平衡 JSON」挑出信号,`normalizeAspSignal` 归一化成 `transport='okx_asp'` 的 `TraderSignal`,再走**同一个** `handleSignals` → `TraderFollow.ingest` → 人工 apply/skip。去重键是 `message_id`(没有就 `row-<id>`,已见集合落 kv `okx_asp.seen`,5000 条 FIFO);只有 `signal_type='order'` 入流,`analysis` 只计数留摘要;挑不出信号或归一化失败的行把原文留进 kv `okx_asp.raw:<id>`;`can_enter`/`is_executable` 明确为 false 的走现有 `backfill` 语义(永远 `review_only`)。读不到库时按 `5s × 2^(n-1)` 封顶 60s 退避,守护没跑不刷屏。订阅动作(挑 ASP、付费、签名)**不在网关里做**,留给 Claude 里的 `okx-ai` 技能;这里只读 `onchainos agent my-subscriptions --role buyer` 拿 ASP 名(缓存 60s,失败不影响轮询)。设置两项:`follow.okx_asp_enabled`(默认 false)与 `follow.okx_asp_poll_ms`(默认 3000,界 1000–300000);`follow.enabled` 关着时一行都不轮询。路由三个:`GET /api/follow/okx-asp`(状态:库路径、上次轮询、入库/忽略分析/坏行计数、订阅列表)、`POST /api/follow/okx-asp/poll`(手动拉一次)、`GET /api/okx/account`(三盏灯 `wallet`/`a2a`/`trade_kit`,各带 `{ok, detail, checked_at}`,缓存 30s,`?fresh=1` 强刷;不依赖当前交易所)。spawn CLI 时**进程环境原样继承** —— OKX 后端要走代理,删掉 `*_PROXY` 会静默超时。

测试:`npx vitest run test/demo/trader-follow.test.ts test/demo/follow-http.test.ts test/demo/follow-review.test.ts test/demo/okx-asp-feed.test.ts`(152 条;第三个文件按四轮对抗复审的编号逐条对应,标题里写着是哪一条)。迁移 `0022_trader_signal.sql` 建信号表并给判断账本的 `source` 列加 `trader` 触发器(跟单腿与 online 的模型判断不是同一个实验,默认查询看不见它)。

### Independent Agent controls (2026-09-16)

`POST /api/bots/:role/enabled` accepts `{ "enabled": true|false }`; `role=all`
updates all eight roles. The existing profile `enabled` state is persisted across
restarts. Each role's scheduled/manual entrypoints and queued chat starts enforce
this state; chat checks again before subsequent model calls and tool dispatch.
Existing workflow pause/scheduler and approval settings remain independent.

Executor pause blocks new account/settlement reads and execution calls. Accepted
operations drain through protection and cleanup; it does not cancel an in-flight
CLI. Explicit emergency halt remains available even while Executor is paused.
Account snapshots stop refreshing while paused. Portfolio/Risk role controls stop
role autonomy/chat, but hard risk checks, alerts, safety demotions and emergency
protection are not disabled. Lab pause prevents automatic promotions.

The top bar exposes an Executor shortcut and an eight-role control menu; the team
card also has individual buttons. 
现货/永续市场：接口 `market` 缺省为 `perp`；OKX 与 paper 支持 `spot`，Binance 通道只支持 `perp`。现货只做多、杠杆为 1，独立保护凭据与行情缓存；`GET /api/market/basis?symbol=BTCUSDT` 提供十秒缓存的基差。OKX 简单账户模式在本地拒绝永续请求。CLI 现货成交历史超出三天或不能证明单页覆盖时，结算保持未知。

市场功能验证：`cd packages/gateway && npx vitest run`；类型检查 `npx tsc --noEmit -p packages/gateway`；构建 `npm run build --workspace packages/gateway`（后两条在仓库根执行）。OKX 执行测试注入假进程，不启动交易 CLI。

### 策略研究工作台（research v2）

`src/demo/research/` 与 `/api/research/*` 提供不可变行情/实验、现货 A/B/C 共用账本、历史代理适配、预算、对照和受限研究工具；不会写线上策略或下单。Schema 在 `packages/contracts/schema/research.json`。

设计/量化边界见 `docs/research/architecture-and-evaluation.md`，前端/API交接见 `docs/research/claude-frontend-handoff.md`。根目录先运行 `npm run build -w @trade-gate/gateway`；零费用样本：`node packages/gateway/scripts/research-demo.mjs /absolute/scratch/output`。第二轮增加多资产 universe/screen、共享现金回放、IR/20 个原语/compile、模型失败恢复和诊断/零模型消融，详见 `src/demo/research/README.md` 与 `docs/research/round2-report.md`。测试：本包运行 `npx vitest run test/demo/research --maxWorkers 4`。样本的合成数据/脚本决策不代表真实代理收益。

### OKX 资产全集与每日全市场扫描(2026-09-24)

`src/demo/universe-okx.ts` + `routes-universe.ts`(在 `routes-research.ts` 里注册),设计见 `docs/design/watch-screener-review-2026-09-24.md` 二-1。零模型、只读公共行情。

- 资产全集:OKX 在售 USDT 现货 + USDT 本位线性永续,按 `BTCUSDT` 合并,落库 `okx_universe_asset`(迁移 0043);一次刷新 5 个请求,每个失败重试 3 次,失败保留上次的表。每天 UTC 00:10 自动刷新;开机 30 秒时缓存超过 24h 也刷。`TG_UNIVERSE_AUTO=0` 关自动,vitest 与 `TG_EXCHANGE=binance` 下默认不自动。
- 接口:`GET /api/universe?market=spot|perp|all&q=&limit=&sort=volume|change|funding&order=&include_excluded=`、`POST /api/universe/refresh`、`GET /api/universe/scan`。
- 每日全市场扫描:刷新后对全集(排除稳定币/包装币)的 24h 成交额前 150 个拉 4h/1d K 线(每币 2 个请求),按 screener 中线口径打分,存成 `demo_screen`(horizon=`daily`,universe=`okx_all`)+ 候选;其余只按成交额排序。
- 90 天成交额:只对这前 150 个算(Σ 日线 volume×close 的近似,有永续用永续 K 线),其余为空。
- `screener_universe=okx_all`:radar 先取当天扫描候选,再按成交额补齐,只取有永续的。
- 测试:`npx vitest run test/demo/universe-okx.test.ts test/demo/funnel-okx.test.ts`。

### Strategy Run（§9.51）

`src/demo/strategy-run.ts` 在研究表所在的 marketDb 保存运行、事件与收盘去重键；`routes-strategy-runs.ts` 提供运行/预检/参数/扫描/事件接口。运行器每 15 秒检查策略自身周期，收盘后 5 秒扫描，和账户操作共用 runtime 队列。版本钉住，暂停/停止禁止新开仓，已有仓位继续按原版本 `irExit` / `orderManager` 管理（全局暂停/紧急停止/Executor 暂停仍优先）。运行进入慢 IR 错误后不自动再计算，需人工恢复。

`strategy-run-orders.ts` 对有 order 块的 IR 直接复用研究 `orderIntents`（内部 `resolveOrder`）：限价按信号根重锚，时效从该根收盘开始计；仅永续支持 short/both，持仓退出复用方向对称的 `orderManager`。无 order 块的旧 IR 仍走 `irCandidate`。运行池每根用研究 `buildUniverse` / `screenUniverse` 构造等权市场因子与筛选行，共用 `passesUniverseScreen`，历史不足跳过；运行器分页拉取筛选所需历史。

止盈按研究核排序、归一比例。单档完整执行；多档在纸面和 OKX 只挂第一档指定数量的原生止盈（按交易步长向下取整），线程 `run_take_profit` 在发送前冻结 CID，回执未知不另造 TP；`tp_partial_unsupported` 记录未挂档位，预检 `targets_partial` 明示余仓只由止损/信号/时间退出管理。其他通道多档仍阻断。限价过期复用 `followCancelEntries`，确认撤单后才记 `skip(entry_expired)`；运行暂停/停止、工作流暂停和 Executor 暂停也清理到期挂单，迟到审批拒绝。

仍不执行追踪/保本改止损与同币新信号替换/结转/加仓/反手，预检 warnings 明示；无硬止损、Pine、超出历史窗口等仍阻断，并给修正方法。agent 入场过滤只允许 follow/skip，不改价格，失败即 skip。

验证在此包目录执行：`npx tsc --noEmit -p .`、`npx vitest run test/demo/strategy-run.test.ts`。测试使用内存 SQLite、注入行情/过滤器/发布器及 PaperBackend，不访问真实交易所或付费模型。

页面性能排查：`scripts/start-perf-dev.sh` 只启动独立 18831/5211（paper、副本库）；
`scripts/measure-page-perf.py --output .codex-reports/page-perf-after.json` 热身后按接口测五轮。
回归覆盖 `test/demo/read-cache.test.ts`、`market-read-cache.test.ts`、`page-history.test.ts`、`memory-scope.test.ts`。

### 九角色身份与规范对话线程（§9.55）

`src/demo/agent-registry.ts` 是名称、callsign、工具白名单与循环图的唯一口径；
`agents/<role>.md` 提供九个角色的身份与职责，`agent-doc.ts` 按包根定位并按 mtime 失效。
`GET /api/agents` 返回九张卡片，`GET /api/agents/:role` 返回身份文档、流程图和近期运行/交接。
循环状态读取实际运行记录及已有调度器；对话状态经 `chat.status` 推送。

迁移 `0052_agent_roster.sql` 归档遗留的临时角色会话，保留全部原消息；
`DemoStore` 启动时补齐 `default` 与八个 `agent:<role>`。按 role 创建会话幂等，规范线程不可归档或删除，允许 reset。
角色权限在工具调用前检查。ASP 新增五个工具只读 SQLite / 已有内存快照，冷缓存逐块报告 `ready:false`，操作链接统一指向 `#market`。

验证（仓库根）：

```sh
npm test -w packages/gateway
npm run typecheck
node packages/gateway/scripts/agent-roster-readonly.mjs
```

最后一条脚本默认只读 `~/.trade-gate-okx/demo/state.sqlite`，打印九个系统提示长度、ASP 总览和 SQLite 写入计数；
它不迁移、不创建 runtime、不调用模型/CLI。可传数据库路径。需先 typecheck 或 build 生成 dist。
定向回归文件是 `test/demo/agent-roster.test.ts`、`chat.test.ts`、`queue.test.ts`。
