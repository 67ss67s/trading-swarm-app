# 策略归因 + 短中长分层 + 黑盒决策规范化(2026-09-12 晚)

Jacky 上线后的第一批要求,原话转述:**按方向、交易频率、止损/止盈、回测周期(15m)与 screener 五个维度
拆解每条策略的实盘/paper 表现;按短、中、长 horizon 分层管理;把黑盒决策规范化。**

三件事其实是一件事的三面:**「这条策略赚不赚钱」要拆到能改的维度上(归因);「不同持有周期不能共用一套
容量/频率/入场约束」要拆到层上(分层);「模型到底在哪一步做了决定」要拆成三栏(规范化)**。
归因缺了分层就是把 5m 和 1d 的 R 混在一个池子里平均;归因缺了决策记录就只能解释已成交的那些,
解释不了「它本来想做但被拒了」那半边。

本文只写这一包。**不动** strategy-signals / outcome / replay-stats / strategy-lab(两个 astra 在改),
**不动**执行/撤单/保护段。

---

## 0. 口径先说死(否则下面每个数都可以解释成两种东西)

| 词 | 本文口径 |
|---|---|
| **一笔样本** | 一条 `status='closed'` 且 `settlementComplete(t) === true` 的 `StrategyThread`。非 complete 的一律不进任何统计(和 judgment-ledger 同一条铁律)。 |
| **净 R** | `settlement.net_pnl / initial_risk_usdt`,与 `strategy-loop.realizedRFromThreads` 逐字同一套公式(含手续费与资金费)。没有 `net_pnl` 时退回 `(exit-entry)*qty/risk`,并标 `r_source='price'`。**本文没有任何一个毛值。** |
| **汇总键** | `(strategy_id, strategy_version, backend)`。不按 id 汇总——一条策略的 v1 和 v2 是两条策略;paper 和 agent_mcp 的成绩不能相加。 |
| **样本不足** | 整块 `n < 10`(`ATTRIBUTION_MIN_SAMPLE`)→ 该块 `insufficient: true`,块内所有**推断量**(期望、胜率、中位数、差值)写 `null`;**计数量**(每个桶几笔)照常给。数不够就不许出结论,但不许假装没数据。 |
| **tier** | `short / mid / long`,由 `StrategySpec.horizon` 唯一映射(见 §2.1)。线程上没有策略时按 `inferHorizon(thread.timeframe)` 兜。 |

---

## 1. 归因报告

### 1.1 形状

核心是**纯函数**,不碰 store、不看时钟:

```ts
// attribution.ts(扩展,旧的模型归因 AttributionPoint 一行不动)
export interface AttributionTrade {
  thread_id: string; symbol: string; direction: Direction;
  opened_at: number; closed_at: number;
  timeframe: string;                    // 线上入场周期
  net_r: number; r_source: 'settlement' | 'price';
  exit: ExitKind;                       // 出局分类(枚举)
  stop_distance_pct: number | null;     // |entry-stop|/entry × 100
  cost_over_risk: number | null;        // (手续费 + 资金费支出) / 初始风险 —— 「费/初始风险比」
  origin: SymbolOrigin;                 // 这个币从哪来
  mae_r: number | null; mfe_r: number | null;  // 线上不记录,默认 null(见 §1.6)
}

export function summarizeAttribution(
  trades: readonly AttributionTrade[],
  opts: { replay_timeframe: string; replay_oos_net_expectancy: number | null; window: [number, number] | null;
          opportunities: OpportunityCounts | null },
): AttributionReport;
```

`ExitKind = 'stop' | 'take_profit' | 'expiry' | 'invalidation' | 'manual' | 'other'`
`SymbolOrigin = 'radar' | 'whitelist' | 'watchlist' | 'manual' | 'unknown'`

两者都是**枚举**,由 `close_reason` 文本 / 候选表在 `attributionTradeOf()` 一次性归一化。
**报告里不出现任何自由文本分类** —— 自由文本正是「黑盒」的形态。

### 1.2 五个维度

**A. 方向**
```
direction: { insufficient, n,
  long:  { n, net_r_sum, expectancy_r, win_rate },
  short: { n, net_r_sum, expectancy_r, win_rate },
  skew: number | null }     // long 期望 − short 期望;正 = 这条策略只有多头能赚
```

**B. 频率**
```
frequency: { insufficient, window_days, 
  opportunities_per_week, opens_per_week, opens: n,
  opportunities,                       // 这条策略「被唤醒并进了允许集」的次数
  blocked: { gate: string, n: number }[],   // 被闸拒的分布,按闸名降序
  conversion: number | null }          // opens / opportunities
```
机会数与被闸拒分布**只来自 `decision_record`**(§3)。`decision_record` 之前的 episode 没有结构化
允许集,硬拼会拼出一个不可复核的数;报告里写 `coverage_from`(最早一条 decision_record 的时刻),
用户自己知道这个窗口从哪天开始有效。

**C. 止损 / 止盈**
```
exits: { insufficient, n,
  by_kind: { kind: ExitKind, n, share, expectancy_r }[],   // 止损出局占比 / TP 出局占比 / 到期出局
  mae_r_p50, mfe_r_p50,                                    // 中位;线上无数据时 null + note
  stop_distance_pct_p50,
  cost_over_risk_p50 }                                     // 止损距离 vs 成本比
```
`cost_over_risk` 是 Codex 复审里点名的那个诊断量:双 taker 10bp 想把费用压到 ≤ 0.1R,价格止损距离
至少得 ~0.7%。这个比值 > 0.2 基本等于「策略在给交易所打工」。

**D. 周期一致性**
```
period: { online_timeframes: { tf, n }[], replay_timeframe,
  consistent: boolean,                 // 全部线上入场周期 == 回放周期
  mismatch: { tf, n }[],               // 不一致的逐条列出
  live_net_expectancy_r, replay_oos_net_expectancy_r,
  gap: number | null }                 // 线上 − 回放 OOS;null = 任一侧 insufficient
```
`gap` 是这份报告里最贵的一个数:**它是「回放说的」和「真的发生的」之间的距离**。
回放周期取该版本 `lab_stats.timeframe`,缺省 `REPLAY_TIMEFRAME = '15m'`(Jacky 点名的那个)。

**E. screener 来源**
```
screener: { insufficient, n,
  by_origin: { origin: SymbolOrigin, n, share, expectancy_r }[] }
```
`origin` 判定顺序(每条线程在开仓时刻判一次,写死不猜):
1. `thread.source !== 'agent'` → `manual`(人/对话开的,不算 Radar 的功劳也不算它的锅);
2. `(symbol, strategy_id)` 在某次 screen 的候选表里且 `created_at ≤ opened_at ≤ ttl_at` → `radar`;
3. `symbol ∈ workflow.screener_whitelist` → `whitelist`;
4. `symbol ∈ workflow.watchlist` → `watchlist`;
5. 否则 `unknown`(币已经从名单里删掉了,不编)。

### 1.3 HTTP

新文件 `routes-attribution.ts`(在 `http-extra.ts` 的模块表里加一行注册):

```
GET /api/strategies/:id/attribution?version=&backend=&since=&window_days=
→ AttributionReport                       # 单条策略单版本单通道

GET /api/attribution/summary?backend=&since=&window_days=
→ { backend, since, window_days, generated_at,
    by_tier: { tier, n, expectancy_r, insufficient }[],   # 短/中/长三层一眼看完
    strategies: AttributionReport[] }                     # 每个 (id, version) 一份
```
两条都是**只读、零模型、零网络**。归因不 propose、不改版本、不下单 —— 这条老约束继续有效。

### 1.4 与旧 `attribution.ts` 的关系

旧的 `AttributionPoint` / `runAttribution`(便宜大脑读回测吐问题点位)**一行不动**。
新加的是同一个文件里的**确定性**那一半:旧那半是「模型对一次回测的意见」,新这半是
「代码对已结算实盘的账」。同名不同物,所以类型前缀分开(`Attribution*Report*` vs `AttributionPoint`)。

### 1.5 为什么不建表

归因是**纯查询**:输入是已经落盘的线程 + 结算 + 候选表 + decision_record,没有一个字节是归因自己产生的。
建一张汇总表就等于多一个可能和源数据不一致的副本。请求成本是一次 `closedThreads` 扫描,报告端点可接受。
(迁移 0022 因此**没有建**;编号留给下一个真需要建表的人。)

### 1.6 MAE / MFE 的诚实边界

线上线程**不记录**逐根极值(`outcome.ts` 里的 `mae_r/mfe_r` 只存在于回放)。要线上的 MAE/MFE
必须按线程持仓区间重拉 K 线重算,那是一次网络 + 磁盘缓存的开销,不该挂在一个报告 GET 上。
本版:`mae_r_p50 / mfe_r_p50 = null`,`note` 写清「线上线程不记录逐根极值,需按持仓区间重算」。
函数签名已经留好位置(`AttributionTrade.mae_r/mfe_r`),哪天有人往线程上记了,报告自动就有数。
**不编一个近似值冒充中位数。**

---

## 2. 短 / 中 / 长分层

### 2.1 映射

```ts
export type Tier = 'short' | 'mid' | 'long';
export const TIER_OF: Record<StrategyHorizon, Tier> = {
  scalp: 'short',      // 5m,日内几根
  intraday: 'short',   // 1h,当日了结 —— intraday 按定义就是短线
  swing: 'mid',        // 4h,持有几天
  position: 'long',    // 1d,持有几周
};
```
四个 horizon 压进三层,`intraday` 归 short:**当日了结的仓位和跨周仓位不该共享容量**,而
`scalp` 与 `intraday` 在容量/频率上的差别远小于它们与 `swing` 的差别。

### 2.2 `workflow.tier_policy`

```ts
export interface TierPolicy {
  max_open_threads: number;      // 本层同时在手线程上限;0 = 继承全局
  max_opens_per_day: number;     // 本层每日开仓上限;0 = 继承全局
  entry_styles: EntryStyle[];    // 本层允许的入场方式;空数组 = 不限
  council_min_agree: number;     // 本层议会票数门槛;0 = 继承全局
  allocator_slots: number;       // allocator 给本层的名额;0 = 不限
}
workflow.tier_policy: Record<Tier, TierPolicy>
```

**默认全 0 / 空 = 与今天行为逐字一致。** 这是有意的:分层是一套新闸,新闸的默认值必须是
「什么也不改」,否则这次上线会在用户没按任何按钮的情况下改掉钱的行为。Jacky 在设置页里
把数字填上去,分层才真正生效。(`WORKFLOW_BOUNDS.tier_policy` 给每个字段的上下界;
`loadWorkflow` 对老库缺字段 / 手改坏的值 fail-closed 回默认。)

### 2.3 接线

**gates.ts** —— `GateContext` 新增**可选** `tier`:
```ts
tier?: { tier: Tier; opens_today: number; open_threads: number;
         policy: TierPolicy; }
```
不传 → 一行闸都不多(旧调用与旧测试完全不受影响)。传了,且 `action='PROPOSE'` 时多三行:
- `本层每日开仓上限`:`policy.max_opens_per_day > 0 && opens_today >= cap` → 拒;
- `本层容量上限`:`policy.max_open_threads > 0 && open_threads >= cap` → 拒;
- `本层入场方式`:`policy.entry_styles` 非空且提议的 `entry` 不在允许集 → 拒。

**strategy-allocator.ts** —— 只加一段「按层配额」,插在**每族 1 条 / 相关票去重之后、容量之前**:
`AllocatorInputs.tier_slots?: Partial<Record<Tier, number>>`;某层名额用完 → `blocked_by='tier_slot'`,
`reason` 写「short 层名额 1 个已被 X 占用」。`tier_slots` 不传 = 今天的行为。
排序、驻留、冷却、容量的顺序**一个字不改**。

**runtime.ts** —— 只动两处:
1. 开仓闸的 `GateContext` 里补 `tier`(从生效策略的 horizon 取,没有策略时按线程周期推),
   `opens_today / open_threads` 按层重数一遍;
2. episode 落库处写 `decision_record`(§3)。

**前端** —— 策略页按层分组(short/mid/long 三个分区,每区一行小计:几条、合计净期望);
设置页「自动化」组下新增「分层配额」子区,三层各五个字段。

---

## 3. 黑盒决策规范化

### 3.1 一条 episode = 一条 `decision_record`

```ts
export interface DecisionRecord {
  version: 'dr-v1';
  at: number;
  tier: Tier | null;
  /** 一:代码给的允许集(模型看到这个之前就已经定了)。 */
  allowed: {
    actions: Action[];                       // 图给的合法边
    entry_styles: ('market' | 'limit')[];    // entry_style 闸算出来的
    council: { reached: boolean; direction: Direction | null; agreeing: number; required: number } | null;
    strategies: { id: string; version: number; content_hash: string }[];
    codes: DecisionReasonCode[];
  };
  /** 二:模型选了什么。 */
  model: {
    action: Action | null; direction: Direction | null;
    entry: 'market' | 'limit' | null; confidence: number | null;
    illegal_action: string | null;           // 第一次输出的非法动作(已被修复/fail-closed)
    codes: DecisionReasonCode[];
  };
  /** 三:闸之后真的执行了什么。 */
  executed: {
    action: Action | null; passed: boolean;
    blocked_by: string[];                    // 没过的闸名(GateResult.name,不是自由文本)
    intent_id: string | null;
    codes: DecisionReasonCode[];
  };
  evidence_plan_hash: string | null;
  /** sha1(sorted `id@version@content_hash`):这次判断用的是哪一套策略版本。 */
  strategy_version_hash: string | null;
}
```

### 3.2 reason code 是枚举,不是文本

```ts
export const DECISION_REASON_CODES = [
  // 允许集
  'code_graph_edges', 'code_council_consensus', 'code_council_no_consensus', 'code_council_off',
  'code_entry_free', 'code_entry_prefer_limit', 'code_entry_limit_only', 'code_no_strategy',
  // 模型
  'model_within_allowed', 'model_illegal_repaired', 'model_failclosed', 'model_no_output',
  // 闸后
  'gate_pass', 'gate_blocked', 'gate_not_applicable', 'gate_tier_daily_cap',
  'gate_tier_capacity', 'gate_tier_entry_style',
  'exec_intent', 'exec_awaiting_approval', 'exec_none',
] as const;
```
三个 `codes` 字段的类型是这个联合,**不是 `string`**。`tsc` 就是校验器;再加一条运行时
`isDecisionReasonCode()` 给 JSON 反序列化的边界用,测试断言「写进去的每个 code 都在枚举里」。

「黑盒」的具体形态就是「理由是一句人写的话,没法聚合、没法对拍、没法当统计维度」。
换成枚举之后,§1.2 B 的「被闸拒的分布」才是一个能画出来的直方图。

### 3.3 落在哪

`decision_record` 挂在 **Episode JSON 上**(和 `evidence_plan` / `evidence_plan_hash` 同一个模式),
不建新表:它和 episode 是严格 1:1,分表只会多一个可能对不上的副本。
`GET /api/judgments/:id` 追加 `decision_record` 字段;旧 episode 没有 → `null`,
前端显示「这次判断早于决策记录」。

### 3.4 前端三栏

判断记录页的展开区新增一个 `decision` 页签,三栏并排:
**代码允许 →|模型选 →|闸后执行**。每栏下面是它的 reason code 徽章(中文标签由前端的
`DECISION_REASON_LABEL` 映射,**后端只发 code**)。三栏之间不一致的地方(模型选了允许集外的、
闸把模型选的拒了)用颜色标出来 —— 那几处就是「黑盒在哪里」的答案。

---

## 4. 契约与迁移

- 契约 `docs/demo/v3-ui-contract.md` 追加 **§9.37**:归因端点形状、`Tier`/`TierPolicy`、
  `DecisionRecord` 与 `DECISION_REASON_CODES` 全量枚举、三栏 UI 约定。
- 迁移 **0022**:**本包没有建表**(§1.5 / §3.3 说明了为什么),编号保持可用。

## 5. 测试

| 用例 | 断言 |
|---|---|
| 方向拆分 | 多空混合 12 笔 → long/short 各自 n/净 R/胜率;`skew` 符号正确 |
| 净 R 口径不漂 | 同一批线程,`attributionTrades().map(r)` === `realizedRFromThreads()` |
| 止损/止盈分类 | `close_reason` 六种文本 → 六个 `ExitKind`;占比之和 = 1 |
| 费/风险比 | 已知 commission/funding/initial_risk → `cost_over_risk` 精确值 |
| 周期不一致 | 线上 1h × 3 + 15m × 9,回放 15m → `consistent=false`,`mismatch=[{1h,3}]` |
| screener 来源 | 候选表命中 / 白名单 / watchlist / 手工 四条各一笔 → 四个 origin |
| 样本不足 | n=9 → 整块 `insufficient`,推断量全 null,计数量仍在 |
| 分层配额 | tier_policy 每日上限 1,本层已开 1 → 闸拒;默认 0 → 不多任何一行闸 |
| allocator 按层 | short 名额 1,两条 short 候选 → 第二条 `blocked_by='tier_slot'` |
| decision_record | 三栏字段齐全;每个 code ∈ 枚举;非法 code 被 `isDecisionReasonCode` 拒 |

`tsc --noEmit` 干净;webui `typecheck` + `build` 过;gateway 全量测试在基线 1224 之上只增不减。
