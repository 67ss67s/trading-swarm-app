# CandidateV0 影子候选(2026-09-23)

对应 `docs/design/strategy-apply-spec-2026-09-23.md` §10 和 `docs/design/judgment-exit-redesign-2026-09-23.md` §4 方案 B、§7 第 3 条。这次只做 shadow:不下单、不调模型,只写 `demo_strategy_candidate` 一张表。契约见 `docs/demo/v3-ui-contract.md` §9.50。

要回答的问题是:研究台的 StrategyIR 能不能在实盘循环里用代码直接算出交易候选(方向、入场参考、止损、目标、失效线、RR),和模型对同一币同一时段的提案并排记下来,到期后再结算,给「IR 定几何、模型只做过滤」攒前向证据。

## 文件

- `packages/gateway/src/demo/strategy-candidate.ts`:核心逻辑,包括选 IR、生成、落库、配对、结算、汇总和运行时入口。
- `packages/gateway/src/demo/routes-candidates.ts`:两条只读路由,`GET /api/candidates`、`GET /api/candidates/summary`。
- `packages/gateway/src/migrations/0041_strategy_candidates.sql`:建表 `demo_strategy_candidate`,不做回填。
- `packages/gateway/scripts/candidate-replay.ts`:在库副本上离线回放,拒绝现网库路径。
- `packages/gateway/test/demo/strategy-candidate.test.ts`:9 条测试。

导入这些模块没有副作用,模块级只有进程内的节流变量。两行钩子挂上之前,这些代码不会运行。迁移会在下次网关重启时建一张空表,别的什么都不动。关闭开关是 `TG_CANDIDATE_SHADOW=0`。

## 影子的是哪条 IR

`loadIRForShadow(db)` 从研究台当前版本里选,条件是周期 ≤ 1h、long-only(`order.direction` 缺省或为 long,没有 short_signal/short_regime,signal 里没有 `direction:'down'`)、不含 Pine 原语、没有 `universe.screen`、未归档。按 live > paper > published > backtested > draft 取第一条。

OKX 库里研究台 21 条当前版本全是 1d/4h,没有一条合格,所以现在用的是合成 IR:旧 `donchian_close_long_v1` 策略经 `policyToIR(SYNTH_POLICY)` 转成 IR。参数是 20 根收盘突破、1.2 倍量、ATR14×2 止损、2R 目标、`time_stop` 48 根,和研究台 `defaultIR` 同一组。其他字段:

- `strategy_id = synth:donchian_close_long_v1:1h`,`version = 1`
- `ir_hash = hash(ir)`,用的是 research/primitives.ts 的 `hash`,和研究台 `ir_hash` 同一个函数;现在是 `6a79965c9264…`

以后研究台出现合格的 ≤1h 版本,会自动换成它,不用改代码;`strategy_id@version` 和 `ir_hash` 会随之变化。

## 候选怎么生成,和研究引擎的重复

几何由 `irCandidate(ir, ctx)` 算,直接 import 自 research/strategy.ts,没有复制。

ctx 的口径和 engine.ts `runReplay` 对第 i 根的构造一致:最近 W 根已收盘 bar(含当根)、`i = 最后一根`、`timeframe_ms`。W 用 engine.ts 导出的 `viewBars(ir, …)`,即 clamp(6×预热, 500, 5000)。高周期原语由基础周期 bar 自己聚合,不需要另外拉高周期 K 线。

有两处重复,需要跟着研究代码同步:

1. engine.ts 里 ctx 是 runReplay 循环体内的内联表达式,没有导出 helper,所以 `researchContext()` 按同一口径重写了这三行。
2. Kline 转 ResearchBar 的 `toResearchBars()` 按 research/market-dataset.ts 的口径写:`close_time = available_at = open_time + 周期 − 1`,只收已收盘的 bar。

合成 IR 带 `compatibility:'donchian_close_long_v1'`。研究引擎遇到这种 IR 走旧的 `candidateAt()`,影子一律走 `irCandidate()`。测试在 600 根随机游走上逐根对比了两条路径,触发与否、止损、目标都一致。

候选字段:

- `as_of`:信号根收盘时刻(`open_time + 周期`,落在整点)。
- `entry_ref`:信号根收盘价,也是 irCandidate 的几何锚。真实入场按下一根开盘,结算时的 `fill_price` 用的是开盘价。
- `stop`:取 `risk.stop` 原语。
- `target`:有 `fixed_r_target` 就用它(取最小 r),否则用 `structure_target`,都没有就是 null。
- `rr = (target − entry_ref)/(entry_ref − stop)`。
- `invalidation = stop`:按单线规则,失效线就是止损。
- `horizon_bars = min(48, time_stop)`。

结构目标如果落在入场价下方,不改它,记进 `unmapped` 并按无目标处理。

### unmapped:做不到的一律写明,不近似

下面这些情况都进 `unmapped[]`:

- `entry` 不是 `next_open_market`。
- 多目标;irCandidate 取 fixed_r 最小值,其次 structure_target。
- 计划腿不模拟的出场原语:indicator_cross_exit、trend_break、breakeven_after_r、swing_structure_stop 等。
- IR 自带的 chandelier_trail 参数不是 22×3 时,吊灯腿仍固定用 ATR22×3 对照。
- `order.*` 里的限价入场、多档止盈、min_rr(只记录 rr,不据此拒单)、杠杆,以及其他 order 字段。
- time_stop 长于 48 根。
- Pine 原语和 `universe.screen`:这两种 IR 本身不合格,不会被选中。

sizing 和影子几何无关,不在 unmapped 里。合成 IR 的 `unmapped` 为空。

## 配对:IR 候选对模型提案对最终闸结果

`matchModelEpisode` 在 demo_episodes 里找同一币、`episode.as_of` 落在候选 `as_of` ±1 根策略周期内、离得最近的一条;距离相同先取扫描再取复查。记录这些字段:action、direction、模式(scan/review)、trigger、`gates_failed`(没过的闸名)、`intent`(闸后是否真的生成 intent,也就是最终放行)。

bucket 分为 `propose_same / propose_opposite / no_trade / watch / review / no_judgment / no_episode`。其中 `no_episode` 表示窗口内模型根本没被问过。

候选刚生成时模型的扫描往往还没跑,所以配对要等窗口关闭才定稿:`as_of + 1 根 + 2 分钟` 之后,由下一次钩子调用的 `matchPending` 完成。定稿前 `model_action` 是 NULL,汇总里记作 `pending`。

汇总里还有反方向的覆盖率 `model_proposals_without_candidate`:同一时段模型扫描 PROPOSE 了,但 ±1 根内没有 IR 候选的次数。

## 结算

到期(`as_of + horizon` 根)后拉 `horizon + 25` 根 K 线,算两条腿:

- 计划腿:outcome.ts `simulateOutcome`,下一根开盘市价成交,同一根同时碰到止损和止盈算止损,跳空按开盘价,到期按收盘。`outcome_r` 存毛 R,json 里另有 `net_r`(按 DEFAULT_COSTS)。
- 吊灯腿:入场起止损取 max(计划止损, 入场后最高价 − 3×ATR22),ATR 和最高价都只用已收盘的 bar,止损只上移、没有目标、到期按收盘,存 `outcome_r_trail`。和 scripts/ledger-backfill.ts 的 `walkChandelier` 逐行同口径,但那个脚本有顶层副作用不能 import,所以用 `openTrade/stepTrade` 重写了。区别是 backfill 最长走 7 天,这里用同一个 48 根窗口。

K 线不全时先等;过了 `as_of + (horizon+4)` 根还不全,记为 `unscoreable`。下一根开盘价已在止损下方时,记为 `invalid`。

汇总同时给全量口径和不重叠口径(`nonoverlap`)。全量口径下每根突破都记一条;不重叠口径下,同一策略同一币上一条的计划腿还没出场时,后面的候选跳过,相当于研究引擎 A 臂的持仓语义。

## 运行时入口

`runCandidateShadow(deps)` 在每根工作流 K 线收盘时调用一次,不 await,自己吞掉所有错误,绝不打断实盘循环。流程:

1. 判断策略周期(1h)有没有新收盘的 bar。有的话,对 watchlist 拉 W+2 根 K 线生成候选并落库。同一个 `(strategy_id, version, symbol, as_of)` 只落一条:主键是这四项的哈希,另有 UNIQUE 约束。
2. 某个币拉数失败,或交易所还没给刚收盘那根,这一根下次调用再试。
3. 每次都执行 `matchPending`。
4. 每 10 分钟最多结算 20 条。

用 15m 工作流驱动 1h IR 时,每小时的第一次 15m 收盘就会生成。另外有进程内互斥,防止重入。

## 两处钩子(由主线程落,本次没有动 runtime.ts / http-extra.ts)

注意:路由注册在 `http-extra.ts` 的 `extraRouteModules`,不在 http.ts。这两段在临时工程里对当前树做过 tsc 验证,import 路径和类型都能通过。

**runtime.ts**:放在 `onKlineClose` 开头、任何提前 return 之前,这样暂停或 halted 时影子照常记录。

```diff
--- a/packages/gateway/src/demo/runtime.ts
+++ b/packages/gateway/src/demo/runtime.ts
@@ (import 区,例如紧跟 `import { ConfirmationStore, … } from './confirm.js';` 之后)
+import { runCandidateShadow } from './strategy-candidate.js';
@@ async onKlineClose(at: number): Promise<void> {
     const closed = new Date(at - 5000).toISOString().slice(11, 16);
     const detail = `${this.workflow.timeframe} K 线 ${closed} UTC 收盘`;
+    // CandidateV0 影子候选(docs/research/candidate-v0-2026-09-23.md):零下单零模型、自己吞错、不 await,不挡实盘循环。
+    void runCandidateShadow({ db: this.store.marketDb, symbols: [...this.workflow.watchlist], log: (level, message, data) => this.log(level, 'candidate', message, data) });
     const session = sessionInfo(Date.now());
```

**http-extra.ts**:

```diff
--- a/packages/gateway/src/demo/http-extra.ts
+++ b/packages/gateway/src/demo/http-extra.ts
@@
 import { botRoutes } from './routes-bots.js';
+import { candidateRoutes } from './routes-candidates.js';
 import { eventRoutes } from './routes-events.js';
@@ export const extraRouteModules: RouteModule[] = [
   attributionRoutes,
   botRoutes,
+  candidateRoutes,
   // 研究工作台必须排在 eventRoutes 前面:…
```

测试里 DemoRuntime 的 onKlineClose 也会调到钩子。它会请求假行情服务器拉 1h K 线,失败会被吞掉。如果有测试统计请求数,测试环境设 `TG_CANDIDATE_SHADOW=0`。

## 离线回放结果(库副本,不是前向证据)

`npx jiti packages/gateway/scripts/candidate-replay.ts --db <副本> --days 30`,跑在 `~/.trading-swarm-okx/demo/state.sqlite` 的 `.backup` 副本上,OKX 永续 1h,通过代理拉取。watchlist 取自副本的 `demo.workflow`:BTC/ETH/SOL/BNB。回放窗口 2026-08-23 21:00 到 09-22 21:00 UTC。

- 候选 134 条,已结算 120 条(另 14 条未满 48 根),`rr` 全是 2,全部有目标。
- 计划腿:50 次止盈、66 次止损、4 次到期,胜率 43.3%,期望毛 +0.28R、净 +0.18R。
- 吊灯腿:+0.47R。
- 不重叠口径 57 条:计划腿毛 +0.35R、净 +0.24R,吊灯腿 +0.52R。
- 分币(计划腿/吊灯腿):BTC +0.07/+0.48,ETH +0.49/+0.64,SOL +0.14/+0.43,BNB +0.44/+0.34。

配对只在有模型 episode 的时段才有意义。副本里扫描 PROPOSE 从 09-20 23:00 才开始,所以 120 条已结算候选全部落在 `no_episode`,那段时间模型循环没在跑,这不能算作「模型没被问」的证据。

有 episode 的时段(09-19 起)共 14 条候选,都还没到结算期:

- 11 条配到了 episode,全部是 `trigger=event` 的扫描。其中 WATCH(方向 long)7 条,NO_TRADE 1 条,PROPOSE 同向 3 条。
- 那 3 条同向 PROPOSE(BTC 09-21 09:00、10:00,ETH 09-21 10:00)都被「提交前重闸」拦下,没有生成 intent。
- 另 3 条窗口内模型没被问过。
- 反方向上,同一窗口里有 17 次模型扫描 PROPOSE,±1h 内没有 IR 候选。

交叉检查:在副本里 research_datasets 冻结的 OKX 现货 1h 数据上回放 100 天(06-13 到 09-21;BTC 选中的数据集只有 719 根),`--source dataset --days 100`。结果是 314 条候选、306 条已结算,计划腿毛 +0.27R、净 +0.16R,吊灯腿 +0.38R;不重叠口径 161 条,计划腿毛 +0.29R、净 +0.18R,吊灯腿 +0.43R。BNB 最弱:计划腿 +0.06R,吊灯腿 −0.03R。

解读:这条 1h 突破在最近 1 到 3 个月是小幅正期望,吊灯腿在 30 天和 100 天两个窗口都好于计划腿,和 ledger-backfill 的方向一致。但这是单一策略、单一时段、样本内的回放,可以用来预热表和检查口径,晋升只认 `origin='online'` 的前向行。

## 已知限制

1. 研究台没有合格的 ≤1h IR,现在影子跑的是合成的旧唐奇安突破。要验证「breakout_retest 译成 IR」(§10 的建议),得先在研究台把它编译成 ≤1h 的 long-only 版本,选择器会自动接上。
2. 只做 long、下一根开盘市价、单目标、机械出场;上面 unmapped 列的都不模拟。
3. 候选不带持仓状态,每根符合条件的 bar 都记一条,所以汇总另给不重叠口径。
4. 影子按永续 K 线算(和实盘触发器的 `fetchKlines` 默认一致)。工作流 `default_market=spot` 时,现货价格会有细微差异。
5. 配对按时间窗匹配,不看 episode 引用了哪条策略;`review` 表示当时该币有持仓线程。
6. 吊灯腿窗口是 48 根,backfill 是 7 天,两边数字不能逐条对齐。
7. 节流状态在进程内,重启后同一根可能重新生成,但数据库去重保证不会重复落库。
