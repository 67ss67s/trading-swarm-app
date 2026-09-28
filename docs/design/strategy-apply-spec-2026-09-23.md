# 策略接入规范(Strategy → Swarm Apply Spec)与研究台/策略合并方案(2026-09-23)

> 给两个人看:正在做策略对象生命周期的 jacky-f5(Opus 5.5)和之后接 swarm 侧的实现者。字段名以 jacky-f5 09-23 给的契约为准:`ResearchStrategy{id: rs_xxx, current_version, status ∈ draft|backtested|paper|live|published|archived, lab_strategy_id, published_listing_id}`、`ResearchStrategyVersion{strategy_id, version, ir_hash, strategy_ir, report_ids, run_ids?}`、`StrategyIR{signal[], entry, risk:{stop, sizing}, exit[], regime?, order?{direction, market, leverage, entry{type,price?,expiry_bars?}, take_profits?[{source,size_pct}], min_rr?, on_new_signal{unfilled,filled}, max_adds?, max_holding_bars?, breakeven_after_tp?, short_signal?, short_regime?}}`,转移接口 `POST /api/research/strategies/:id/transition {to, confirm?}`(paper→live 要 `confirm:'LIVE'`)。
> 背景批评见 `judgment-exit-redesign-2026-09-23.md` §3 D4/D7。

## 0. 一句话

**策略对象(研究台 IR)是唯一真源;swarm 里跑的是它「编译」出来的绑定(StrategyBinding),模型的角色是绑定上的一个字段,由研究台 A/C 臂结果决定。** 实盘的 `StrategySpec` 从「手写文本 + 4 处硬编码」退化成编译产物;五条内置策略逐条译成 IR,译不了的先留在旧路径并标 `source:'builtin'`。

## 1. 现状对照(为什么要合并)

| 概念 | 实盘(strategies.ts 一侧) | 研究台(research/ 一侧) | 共享 |
|---|---|---|---|
| 策略对象 | `StrategySpec{trigger.kinds, checklist, rules 文本, params}` | `StrategyIR{signal/entry/risk/exit/order 原语}` | 无(只有 B 臂单向读 StrategySpec 文本) |
| 信号识别 | 模型读文本 + `SIGNAL_REGISTRY` 机械版(Lab 用) | 48 个原语,代码逐根算 | 无 |
| radar 触发 | `screener.fitConditions` 按 id switch | `precheck` / `universe.screen` | 无 |
| 止损/目标 | 模型给,闸只拒 | `risk.stop` 原语 + `order-gate.fitOrderGate` | order-gate 注释「实盘接入点未接」 |
| 出场 | holding-policy 通用状态机 + 模型发明的失效价 | `exit[]`(structure_target / chandelier_trail / signal exit / time_stop) | 无 |
| 指标 | indicators.ts 手写 35 个 | primitives/indicators.ts 表驱动 42 个 | 无,口径靠约定 |
| 回测 | backtest.ts(生产 harness 盲回放,永续) | engine.ts A/B/C(现货多头)+ orders/ 执行核(永续,未接路由) | outcome.ts / SpotLedger / simulate.ts 三套 R 账 |
| 状态机 | draft/backtest/shadow/paper/live_capped/retired | draft/backtested/paper/live/published/archived | 词表不同 |
| 晋升证据 | Lab 机械漏斗 + 线上 30 笔 | run 报告(A/B/C、precheck、spec) | 无 |

## 2. 合并原则

1. **一个对象、两个视图**:`ResearchStrategy` 是对象;`StrategySpec` 只是它在实盘的编译视图,字段 `source: 'research'|'builtin'`、`research_strategy_id`、`research_version`、`ir_hash`。`lab_strategy_id` 反向指回 `StrategySpec.id`。
2. **三个正交轴,不是一个状态机**(Codex 复审后修订):研究成熟度 `ResearchStrategyStatus`(draft→backtested→paper→live→archived,jacky-f5 的枚举不变)、部署模式(swarm 侧 binding 上的 `deployment.mode ∈ off|shadow_only|paper|live` + 仓位 cap + effective_at + 回滚目标)、发布状态(`published_listing_id`,与部署无关)。实盘旧词表映射:shadow→deployment.shadow_only、live_capped→deployment.live + cap、retired→archived。这样「published 但已停用」「paper 既下单又不下单」都表达不出来。
3. **一个指标库**:研究台表驱动库为准;实盘 `indicators.ts` 逐个加交叉测试(`engine-crosscheck` 已有脚本),口径不一致的以研究台为准改实盘,回放哈希受影响的 run 标 `indicator_lib_version`。
4. **一个回放核**:研究台 `orders/` 执行核(永续/做空/资金费)是目标;`outcome.ts` 和 `SpotLedger` 收敛到它。`backtest.ts` 保留为「生产 harness 臂」(见 self-evolution §4.3)。
5. **模型的角色是策略的属性**:`agent_mode ∈ mechanical | filter | manage`,由 A/C 臂 alpha 决定,不是全局开关。

## 3. StrategyBinding(编译产物,实盘消费)

```
StrategyBinding {
  strategy_id: 'rs_xxx', version: int, ir_hash: string, compiled_at, compiler_version,
  horizon: intraday|swing|position          // 从 IR timeframe 推;scalp 不接受(1m/3m/5m 拒)
  timeframe, confirm_timeframe,             // IR 主周期;确认周期按 HORIZON_POLICY
  trigger: { primitives: signal[], eval_on: 'bar_close', cooldown_bars, direction: long|short|both },
  evidence_plan: { indicators: [...从原语输入推导], structure: ['swing','range','htf_regime'], info_topics?: [...] },
  entry: { type: market|limit, expiry_bars, on_new_signal, max_adds, chase_atr_max },
  stop: { primitive: risk.stop, buffer_atr, is_invalidation: true },   // 一条线:硬止损 = 失效线 + buffer
  targets: [{ source: structure_target|fixed_r_target, size_pct }],     // 来自 order.take_profits 或 exit[]
  trail: { primitive: chandelier_trail, ... } | null,                   // 只收紧
  breakeven_after_tp: boolean, max_holding_bars: int|null,
  signal_exits: [exit[] 里的 indicator_cross_exit / trend_break ...],   // 触发时才允许 EXIT
  min_rr: number,                                                        // order.min_rr 或 spec 默认 1.5;分母 = 失效线距离
  sizing: { risk_pct_max, notional_cap_usdt, leverage_max },            // paper 阶段 cap 更小
  agent_mode: mechanical|filter|manage,
  evidence: { a_arm: {n, expectancy_r, ...}, c_arm?: {n, alpha_vs_a}, shadow?: {...}, live?: {...} },
}
```

**编译器**(`research/compile-binding.ts`,归研究台;或 gateway 侧 `strategy-binding.ts` 读 IR,归 swarm——建议前者,因为它要用原语注册表):输入 `ResearchStrategyVersion`,输出 `StrategyBinding` + `unmapped[]`(IR 里 swarm 不支持的原语要显式列出,不能静默丢)。编译失败 = 不能 apply。

**Codex 复审后的字段修订**:(1)上面 `trigger/entry/stop/targets/trail/signal_exits` 是 IR 的规范化编译结果(normalized AST + reason code),不是可独立编辑字段;研究回放与线上候选生成必须调用**同一个函数、同一组 fixture**逐字节对拍,否则同一 `ir_hash` 会在研究与生产产出不同订单。(2)binding 要加 `schema_version`、指标库/原语库/数据 adapter/成本模型版本、能力清单、市场/产品/tick/lot/手续费/滑点/资金费假设;`compiled_at` 不进内容哈希。(3)`evidence.*` 会变,不嵌进不可变 binding,改存报告 id + 评估快照 hash。(4)`sizing` cap 与 `agent_mode` 属于部署策略(deployment),不是策略语义。(5)`agent_mode` 拆成 `entry_filter: on|off` 与 `exit_discretion: on|off`;判定统计要存配对样本数、独立簇数、CI、功效、模型与 prompt hash,不能只存 n 与点估计;A/C 按「每个候选机会」配对、skip 记 0R;`exit_discretion` 不能由 C−A 推出,要单独做持仓期配对实验。(6)**当前研究 IR 候选是 long-only**(research/strategy.ts:172-184 止损硬编码在收盘下方、追踪只接受上移),`direction: short|both` 在 orders/ 执行核接入前不能兑现,编译器遇到要判 unmapped。

## 4. 运行时怎么消费

1. **radar**:对资产池每根 `timeframe` 收盘跑 `trigger.primitives`(等价于研究台 `precheck` 的最近 N 根),命中 → `WatchCandidate{strategy_id, wake: 'signal'}`;`fitConditions` 的 switch 退役,内置策略在译成 IR 之前走旧路径。
2. **候选生成(零模型)**:命中 → `StrategyCandidate{direction, entry_ref, stop, invalidation(=stop−buffer), targets, rr, sizing_bounds, evidence_snapshot}`;`rr < min_rr` 或目标没结构空间 → 候选作废并记 `candidate_rejected(reason)`(进漏斗统计,这是 D6 的解)。
3. **模型**:
   - `mechanical`:不叫模型,候选直接进 gates → executor。
   - `filter`:模型看候选 + `evidence_plan` 的证据,只输出 `follow|skip + 叙事 + 风险事件`;不能改任何价格(= C 臂契约,`checkProposalSpec` 记录它有没有做对)。
   - `manage`:filter 的基础上,持仓期在 `allowed_actions` 里选;`allowed_actions` 只在 `signal_exits` 触发 / 已核实利空事件 / 硬止损时包含 EXIT。
4. **持仓**:`trail` / `breakeven` / `max_holding_bars` 由代码每根收盘执行并改交易所条件单(只收紧);`targets` 分批挂单;心跳只在 `manage` 且策略周期收盘,`mechanical/filter` 持仓期零模型调用。
5. **gates / portfolio / risk / executor 不变**;`order-gate.fitOrderGate` 接到 gates.ts 的提案校验(它自己注释里的接入点),参数来自 binding。

## 5. 生命周期与 apply 动作

| 转移 | 谁 | 证据 | swarm 侧动作 |
|---|---|---|---|
| draft → backtested | 研究台(有 run 报告) | ≥30 笔候选,precheck 通过,spec 无 block | 无 |
| backtested → paper | 研究台,人点 | A 臂 OOS 期望 >0、DSR>0、回撤 ≤3R(沿用实盘 promoteGate 的数) | `POST /api/strategies/apply {strategy_id, version}` → 编译 binding → 建/更新 `StrategySpec(source:'research')`,`shadow_only=true`,写回 `lab_strategy_id` |
| paper(shadow_only) → paper(下单) | 人点 | shadow n≥20,滑点/资金费在预算内 | binding.sizing 取 paper cap |
| paper → live | 人点 `confirm:'LIVE'` | paper n≥30 或 shadow+A 臂合并样本≥100 且 `alpha_C−alpha_A` 决定 `agent_mode` | binding.sizing 取 live cap;`agent_mode` 定稿 |
| live → published | 人点 | 同上 + 信号市场规则 | `published_listing_id`;ASP 卖的是 binding 产出的信号(候选),不是模型叙事 |
| 任意 → archived | 人/代码降级 | 30 笔期望 < −0.1R 或连亏 10(沿用) | binding 停用,线程自然收尾 |

版本升级:新版本 = 新 binding,旧线程钉住旧 binding 跑完为止,旧 artifact 引用归零前不可删;新版本只接新候选;未成交挂单是撤还是留必须显式选择;账户级紧急风控永远用最新全局版本。apply 要幂等键 + CAS + outbox,避免研究台与 swarm 双写漂移。`ir_hash` 变 = 新版本,不允许原地改。

## 6. 数据回流(研究台从实盘拿什么)

每笔线程平仓 → `research_strategy_versions.live_stats` 追加一行:`{version, thread_id, exit_reason ∈ tp|sl|trail|signal_exit|time|breakeven|manual, r_planned, r_realized, slippage_bps, funding_paid, hold_bars, agent_action_log}`。exit_reason 词表直接用 research-orders.json 的 `BacktestPlan.exit.reason`,这样研究台的分布图可以把回测和实盘画在一张图上。

## 7. 五条内置策略怎么办

| 策略 | 能否译成 IR | 缺什么 |
|---|---|---|
| breakout_retest(+swing/position 变体) | 能 | 回踩确认原语(retest_confirm)研究台要补 |
| mtf_alignment | 能 | 多周期 EMA 对齐原语(已有 htf_structure_regime 可近似) |
| vol_compression_expansion | 能 | bb_width_rank / squeeze 已在指标表 |
| funding_oi_extreme | 暂不能 | 资金费/OI 数据 adapter(data/catalog 有目录,perp-market.ts 半成品) |
| range_mean_reversion | 部分 | 历史回归概率门(reversionStats)要做成原语 |

先译前三条,走 A/C 臂,结果就是「现有策略到底有没有边」的第一份可信答案。

## 8. 哪些联动没价值(别做)

- 让研究台读实盘 `StrategySpec.rules` 文本当 B 臂规则书(现状)——文本不可复现,结论没法回到 IR;合并后删。
- 双向同步两个状态机——只留一个。
- 让模型在研究台里「挑指标」再回填实盘证据字段——证据字段由 IR 原语推导,不需要模型挑。
- Lab 机械参数探针 ±1 步 → 研究台 `parameter_sweep` 已覆盖,Lab 探针退役,`labAutopilot` 只保留晋升/降级判定。

## 9. 边界(谁改什么)

- 研究台(jacky-f5):`compile-binding.ts`、`live_stats` 表、transition 钩子发 `strategy.applied` 事件、内置三条策略的 IR 译文。
- swarm(下一位):`strategy-binding.ts` 消费、`StrategyCandidate` 生成、holding-policy 读 binding 的 trail/breakeven/signal_exits、radar 用 binding.trigger、`POST /api/strategies/apply`、`fitOrderGate` 接 gates。
- 契约:`v3-ui-contract.md` 新节(建议 §9.47)先写字段再动代码。

## 10. Codex 复审后的最短路径(2026-09-23)

不先做通用几何规则、不先合并状态机。第一步是 **CandidateV0 纵切**:挑一条 long-only 策略(建议 breakout_retest 译成 IR),线上 shadow 同时记录「IR 候选 / 现有模型提案 / 最终闸结果」三者,量覆盖率与语义一致性;通过后才让这一条策略的几何由 IR 接管,再逐条扩展。能力子集先钉死为 `spot|perp-long / market / 单目标 / 机械退出`,不支持的原语编译失败,不能近似。
