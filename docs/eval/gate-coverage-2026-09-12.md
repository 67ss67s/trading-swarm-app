# 闸覆盖 + 派生数字身份(2026-09-12)

这一轮只做一件事:**让评测别再骗人**。两个假象各修一个。

| 假象 | 之前 | 现在 |
|---|---|---|
| 幻觉数字 | 09-04 报的 13 个幻觉里 12 个是模型自己算的浮盈 / 止损距离 / R 差值,口径把它们全判成违规 | 派生数可以带来源标注,代码按标注的证据复算;`hallucinated_numbers`(新)与 `hallucination_raw`(旧)两个口径都出 |
| 闸有效性 | 16 道闸里只有「证据新鲜度」触发过 2 次,其余从没被触发过——没触发 ≠ 有效 | `cases/v4-gates` 每道闸一个必然踩线的定向用例,报告出「闸 × 触发次数」矩阵,任一道 0 次即 FAIL |

两件事都不动闸的语义:闸的判定与文案一个字没改,eval 只是**调**它们、给它们造输入。

---

## 一、派生数字要有身份

### prompt(`packages/gateway/src/demo/context.ts`,`PROMPT_VERSION = demo-playbook-v11-formula`)

> 09-12 复审 P1-16 后已收紧:标注**必须写字段级公式**(`(由 (E6.mark-E7.entry)*E7.qty 算出)`),代码按公式自己复算、
> 带符号相等才放行;旧的「只给编号」写法只算「数值可拼出」(`derived_weak`),照样计入幻觉。下面这段是当时的 v10 原文。

规则 2b 改成「原数 **或** 带标注的派生数」,并新增 2c 限定运算集:

```
2b. reasons / thesis 里出现的每个数字,要么是证据里逐字出现的原数,要么是你自己由证据算出来的派生数;
    派生数必须在数字后面紧跟一个来源标注,格式固定为 `(由 E3,E7 算出)`——圆括号 + 「由」 + 用到的
    证据编号(逗号分隔) + 「算出」。例:「浮盈 66.34 USDT(由 E6,E7 算出)」「距止损 1.8R(由 E9,E11 算出)」。
2c. 派生数只允许这几种运算:两数相减(差)、两数相除(比)、百分比、ATR 倍数、R 倍数;代码会拿你标的
    那几条证据里的数字复算,算不出来或编号没登记就按幻觉计。
```

**为什么选内联括号而不是结构化字段**(`derived: [{value, from, op}]`):GLM / DeepSeek 这类便宜模型在长 JSON 里最常见的失败是「正文改了、平行数组忘了改」。内联标注不需要模型再维护第二份与正文对齐的数据,漏写一个标注只影响那一个数,不会让整段 JSON 失效;也不需要模型说出运算名(说错了反而多一种失败模式),运算由代码试。全角/半角括号、`,`/`,`/`、`/`和` 分隔都认。

### 检查(`packages/eval-a/src/checks.ts`)

- `derivedAnnotations(text)`:找出「数字 + 紧跟的标注」对;标注前面没有数字的(位置写错)不算标注,那个数走旧判。
- `checkDerived(annotation, evidence)`:标注引用的 E 必须全部登记过;取这几条证据值里的全部数字组成数池,用有限运算集复算。
- 运算集:`quote`(就是证据原数,只是四舍五入了)、`diff`、`sum`、`ratio`、`pct`、`atr_mult`(差 ÷ 一个数)、`r_mult`(差 ÷ 差)、`diff_mult`(差 × 一个数,浮盈就是它)、`product`。故意不含幂/对数——运算集越小,复算通过越有说服力。数池上限 32 个数、差集上限 600,避免 O(n⁴) 爆掉。
- 容差:`max(1% × 目标值, 所写小数位的半个单位)`。
- `hallucinationReport()` 一次返回两个口径:`raw`(旧)与 `strict`(新),外加 `derived_ok` / `derived_bad`。

### 指标(`packages/eval-a/src/report.ts`)

| 指标 | 口径 | 状态 |
|---|---|---|
| `hallucinated_numbers` | 新:标注且复算通过的派生数不计 | 硬不变量,= 0 |
| `hallucination_raw` | 旧(09-04 那版):数字必须逐字出现 | INFO,历史对照;`details.false_positives_cleared` = 两者之差 |
| `derived_numbers` | 派生数标注:复算通过 / 复算失败,按运算分布 | INFO |

### 回归(`packages/eval-a/test/derived.test.ts`)

09-04 的原始 run 目录在 `.gitignore` 里(`packages/eval-a/runs/`),不在仓库,所以 13 个样本按 `docs/eval/results-2026-09-04.md` 里记下的数字复原:`止损距离 249.66`、`浮盈 66.34 USDT`、`339`、`339.52`、`340`、`1327`(距 20 根低点)、`331`、`138`、`2.00 倍 R`、`0.231%`、`1.80 ATR`、`1.25 倍` —— 12 个假阳性;外加 1 个真幻觉(凭空的目标价 `112345`)。

结果:**12 个在新口径下全部放行(且复算命中预期运算),1 个真幻觉两个口径都判**。另外三个反向用例也钉住了:标注引用未登记的 `E99` 仍判、标了来源但算不出来仍判、没标注的数字维持旧判。

---

## 二、闸覆盖

### 闸清单(16 道图内闸 + 4 条扩展判定,`guard id` 以 `demo.JUDGMENT_GRAPH.guards` 为准)

| guard | 界面名 | 住在哪 | 怎么造必然触发的用例 |
|---|---|---|---|
| `halt` | 紧急停止 | `gates.ts evaluateGates` | `visible.halted = true` + PROPOSE |
| `paused` | 暂停 | `gates.ts evaluateGates` | `gate_env.paused = true` + PROPOSE |
| `fresh_evidence` | 证据新鲜度 | `gates.ts evaluateGates` | `market.as_of` 比 as_of 早 10 分钟(快照过期),或判断引用了 STALE 证据 |
| `no_position` | 无持仓才能开仓 | `gates.ts evaluateGates` | `account.positions` 非空 + PROPOSE |
| `daily_open_cap` | 每日开仓上限 | `gates.ts evaluateGates` | `gate_env.opens_today ≥ DEFAULT_GATES.max_opens_per_day`(2) |
| `stop_side` | 止损在正确一侧 | `gates.ts evaluateGates` | 做多提议给一个高于标记价的止损 |
| `stop_distance` | 止损距离 | `gates.ts evaluateGates` | 做多止损放在标记价下方 0.05%(正确一侧但太近) |
| `tp_side` | 止盈在正确一侧 | `gates.ts evaluateGates` | 做多提议给一个低于标记价的 `take_profit_price` |
| `confidence_floor` | 信心下限 | `gates.ts evaluateGates` | PROPOSE 的 `confidence < 0.40` |
| `no_add` | 演示版不加仓 | `gates.ts evaluateGates` | 判断输出 `action = ADD` |
| `thread_limits` | 线程/日内限制 | `threads.ts openingBlockers` | `gate_env.other_threads` 里已有同币线程 |
| `no_unknown_orders` | 没有状态不明的订单 | `gates.ts unknownOrderGate` | `gate_env.unknown_intent = true` |
| `strategy_consensus` | 策略共识 | `strategy-council.ts consensusGate` | `gate_env.council_mode = require` 且 `council = null` |
| `entry_style` | 入场方式 | `entry-policy.ts entryStyleGate` | `gate_env.entry_style = prefer_limit` + 价已追出 1 ATR 的市价 PROPOSE |
| `preflight` | 提交前重闸 | `threads.ts preflightBlockers` | `gate_env.preflight = true` + 本币已有外部持仓 |
| `thread_still_open` | 线程仍开放 | `threads.ts reduceReview` | 复查一条 `status = closed` 的线程(`review:closed` 没有任何合法边) |

清单代码在 `packages/eval-a/src/gate-coverage.ts` 的 `GATE_INVENTORY`;有个测试钉住它与判断图的 guards 表一一对应,图里加了闸而清单没跟上会直接 FAIL。

#### 扩展判定(4 条,09-12 当天合并进来的新闸/新判定)

判断图的 `guards` 表(`graph.ts`,属 gateway)还没登记它们,所以单列一份 `EXTENSION_GATE_INVENTORY`,规矩与上面完全一样:**每一行必须有一个必然触发它的用例,0 次即 FAIL**。矩阵对这几行按「闸名 + 拒绝理由关键词」认领(guard id 是这份清单自己起的,不是图里的 id)。

| guard | 界面名 | 住在哪 | 怎么造必然触发的用例 |
|---|---|---|---|
| `protection_never_verified` | 提交前重闸 | `threads.ts preflightBlockers`(§9.31) | `gate_env.preflight = true` + `protection_state = 'never_verified'`(不给持仓,好让拒绝理由里只剩保护腿这一条) |
| `event_blackout` | 事件封锁 | `events.ts eventBlackoutGate`(§9.30) | `gate_env.event_blackout_min = 60` + 一条把 as_of 夹在窗口正中的宏观事件 + PROPOSE |
| `council_gate_effective` | 策略共识 | `strategy-council.ts consensusGate`(§9.25 补正三) | `council_mode = require` + `consensus.gate_effective = false`(`min_agree` 3 > 能投票的策略数 2) |
| `council_entry_timing` | 策略共识 | `strategy-council.ts consensusGate`(§9.25b) | `council_mode = require` + 共识成立但 `entry_timing = 'pending'` + 提议是市价 |

`protection_never_verified` 与两条议会判定住在已有闸的**内部**(拒绝时闸名仍是「提交前重闸」/「策略共识」),所以同一条拒绝会同时记在基础行和扩展行上——这是有意的:基础行数「这道闸拒了几次」,扩展行数「这条判定被触发了几次」。`event_blackout` 则是一道图外的新闸,闸名「事件封锁」在 `guards` 表里查不到。

**两条「必然放行」的对照用例**(语义的另一半,不进矩阵,由测试钉住):
- `gate-event-blackout-exit-allowed`:同一个封锁窗口里的 EXIT,「事件封锁」必须 `passed=true` 且理由写明「只拦开仓」——这道闸不能把人困在仓位里。
- `gate-council-entry-timing-limit-allowed`:同一个 `entry_timing=pending` 的议会结果,提议换成限价则「策略共识」放行。

**一处接法上的将就**:`eventBlackoutGate` / `MarketEvent` 还没从 `packages/gateway/src/demo/index.ts` 转出,而这一轮不动 gateway 源码,所以 `gate-coverage.ts` / `gen-gates.ts` 走了 `@trade-gate/gateway/dist/demo/events.js` 的深路径(gateway 没有 `exports` 字段,NodeNext 下可解析)。gateway 那边补一行 export 之后应当改回 `demo.*`。另外三条判定都从 `demo` 的公开面拿得到,没有将就。

**两处纯抽取**(判定与文案一字未改,只为让 eval 能调到它们):
- `unknownOrderGate(hasUnknownIntent)` ← `runtime.ts:1981` 的内联一行;
- `preflightBlockers(inputs)` ← `DemoRuntime.preflightOpen` 的函数体(`symbolsCache` 查表提成 `symbol_status` 入参)。
`runtime` 现在调这两个函数,`packages/gateway/test/demo/gate-extracts.test.ts` 钉住等价性。
另外 `entry-policy.ts` / `strategy-council.ts` 的闸函数从 `demo/index.ts` 转出(只读公开面,没有新逻辑)。

### 定向用例集 `packages/eval-a/cases/v4-gates`(85 个,全合成)

`node dist/cli.js gen-gates` 生成,纯函数、不碰网络:

- **16 个闸用例** `gate-<guard>`:合成 K 线(平台 + 可选尖峰)+ **脚本判断**。脚本判断写在 case 的 `playbook_text` 里的 `[[STUB_JUDGMENT]]{…}[[/STUB_JUDGMENT]]` 块中,桩大脑原样吐出——规则桩推不出「止损放错侧 / 信心 0.30 / ADD」这类必然踩线的输出,而写在 playbook 里(不是 harness 里)保证它跟 context 一起被记录,重放时看得见。
- **6 个扩展判定用例**(09-12 晚新增):4 个必然踩线 + 2 个必然放行的对照,做法见上一节的表。
- **14 个模型边用例** `edge-<edge id>`:判断图每条 `model_edge` 一个(含 `scan:halted` / `scan:stale` / `scan:watch_only` 三个特殊节点)。
- **49 个事件边用例** `evt-<from>-<event>`:`trigger:<kind>` 标签决定 `inputs.triggerFor()` 给出的 kind。

case 里新增一个可选块 `visible.gate_env`(snake_case):`paused` / `opens_today` / `unknown_intent` / `daily_loss_hit` / `other_threads` / `max_open_threads` / `max_opens_per_day` / `entry_style` / `council_mode` / `council` / `symbol_status` / `preflight`,09-12 晚又加了 `protection_state` / `channel`(§9.31)、`event_blackout_min` / `events`(§9.30)。

事件封锁闸是唯一一道**不只在 PROPOSE 上跑**的扩展闸(runtime 也一样):`opening = PROPOSE | ADD`,其余动作照样出一行但恒 `passed`;它只在 case 写了 `event_blackout_min` 或 `events` 时才跑,别的 case 的闸条目逐字不变。

**向后兼容是硬要求**:`gate_env` 缺席的 case(v1/v2/v3 全部)只跑 `demo.evaluateGates`,与 09-12 之前逐字一致;扩展的那几道闸只对写了 `gate_env` 的定向用例跑。有测试钉住这一点。

### 怎么跑(零成本)

```bash
npm run eval:gates --workspace packages/eval-a
# 等价于:npm run build && node dist/cli.js gates --cases cases/v4-gates --out runs/gates
# 重新生成 case 集:npm run eval:gen-gates --workspace packages/eval-a
```

桩大脑 + 合成 K 线,不调模型、不碰网络,85 个 episode 约 0.6 秒。报告写到 `runs/gates/gate-coverage.md`(+ `gate-coverage.json`);任何一道闸 0 次触发、或任何一条合法边没走到,verdict = FAIL 且进程 exit 2(可以直接当 CI 门)。

### 2026-09-12 的结果

```
闸覆盖 16/16(100.0%);模型边 14/14(100.0%);事件边 49/49(100.0%)
verdict: PASS
```

**09-12 晚重跑**(补上三道新闸/新判定之后):

```
闸覆盖 20/20(100.0%);模型边 14/14(100.0%);事件边 49/49(100.0%)
verdict: PASS
```

新增四行各触发 1 次;`preflight` 从 1 → 2 次(多了保护腿凭证那条)、`strategy_consensus` 从 1 → 3 次(多了 `gate_effective` 与 `entry_timing` 两条)。

(对照:`cases/v1` 那种真实抽样集上 `edge_coverage` 是 8.2% —— 那是 case 集的性质,不是 bug;两者分工不同,定向集保证「闸坏了测得出来」,抽样集保证「判断质量量得准」。)

---

## 顺手发现、但**没有动**的东西(按规矩只记账)

1. **`no_add` 这道闸挂在空处**。`JUDGMENT_GRAPH.guards` 登记了 `no_add`,但没有任何一条 `model_edge` 引用它(图里根本没有 `ADD` 边)。于是 `ADD` 永远同时是「非法边」和「被 no_add 拒」,`path_replay` 那一侧也永远不会期待这道闸。要么给它一条带 guard 的 `ADD` 边,要么把 guard 从表里去掉——现在是两套机制守同一件事。
2. **「每日开仓上限」在同一条路径上有两个不同的默认值**。`gates.ts DEFAULT_GATES.max_opens_per_day = 2`,`workflow.max_opens_per_day = 4`(`openingBlockers` 用的是后者)。runtime 建仓时把 workflow 的值塞进 cfg,所以线上一致;但任何不传 cfg 的调用方(eval 就是)会同时看到 2 和 4 两个上限,谁先拒取决于顺序。
3. **`fresh_evidence` 与 `scan:stale` 节点重叠**。快照过期时节点已经是 `scan:stale`(PROPOSE 不是合法边),闸又拒一次。不是 bug(两层防线是设计),但读报告时要知道同一个 case 会同时计 `illegal_edge_attempts` 和闸拒。
4. **三道新闸不在判断图里**。`event_blackout` 是一道实打实的开仓闸,但 `JUDGMENT_GRAPH.guards` 与 `OPEN_GUARDS` 都没有它;`protection_never_verified` 与议会那两条判定藏在已有闸的理由串里,图上看不出来。结果是 `graph.guards` / `path_replay` 这一侧对它们一无所知,只有闸矩阵数得到。修法是给图补三个 guard id(gateway 侧一行表 + `OPEN_GUARDS`),补完之后这几行就该从 `EXTENSION_GATE_INVENTORY` 挪进 `GATE_INVENTORY`——有测试钉住「进了图就不许再留在扩展清单」。

5. **`gate_reject_rate` 的分母口径**。定向集里 PROPOSE 几乎全被拒,这个指标在 `v4-gates` 上没有意义;闸覆盖报告是独立的一份,不与晋升报告的 verdict 混。

---

## 改到的文件

**gateway**(只抽取与转出,不改语义)
- `src/demo/context.ts` — 规则 2b 改写 + 新增 2c;`PROMPT_VERSION` → `demo-playbook-v10-derived`(09-12 P1-16 后再改为公式口径,`demo-playbook-v11-formula`)
- `src/demo/gates.ts` — 新增 `unknownOrderGate`
- `src/demo/threads.ts` — 新增 `preflightBlockers` + `PreflightInputs`
- `src/demo/runtime.ts` — 那两处改为调用抽出的纯函数
- `src/demo/index.ts` — 转出 `unknownOrderGate` / `preflightBlockers` / `MARKET_STALE_MS` / entry-policy 与 strategy-council 的闸函数
- `test/demo/gate-extracts.test.ts`(新)、`test/demo/review-metrics.test.ts`、`test/demo/strategies.test.ts`

**eval-a**
- `src/checks.ts` — 派生数标注的解析、复算、两口径报告
- `src/gate-coverage.ts`(新) — `GateEnv` / `GATE_INVENTORY` / `EXTENSION_GATE_INVENTORY` / `ALL_GATE_ROWS` / `evaluateAllGates` / `gateCoverage`
- `src/gen-gates.ts`(新) — 85 个定向 case 的生成器
- `src/report.ts` — 三个新指标 + `writeGateReport`
- `src/run.ts` / `src/inputs.ts` / `src/stub.ts` / `src/types.ts` / `src/cli.ts` / `src/index.ts` / `package.json`
- `test/derived.test.ts`(新)、`test/gate-coverage.test.ts`(新)、`vitest.config.ts`(新,只放宽超时)
- `cases/v4-gates/`(新,85 个 case + `_manifest.json`)

**测试**:gateway `vitest run` 52 files / **815 passed**;eval-a 15 files / **91 passed**(09-12 晚补完三道新闸后)。
