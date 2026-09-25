# 策略库并进「我的策略」· 合并计划(2026-09-23)

Jacky 原话:「从用户角度去想就是这里有策略那里又有,最好能 merge 进研究台最好,但是也不是所有东西都 1:1 照搬;可以做一个策略研究出来以后分割规则给各个 agent。」

规范依据:`docs/design/strategy-apply-spec-2026-09-23.md`(研究台 IR 是唯一真源,StrategyBinding 是编译产物,三轴状态)。契约:`docs/demo/v3-ui-contract.md` §9.47,schema `packages/contracts/schema/research-binding.json`。

## 1. 用户看到的最终形态

- 看策略只有一个地方:侧栏「我的策略」。侧栏不再有「策略库」。
- 原策略库页面路由 `#strategies` 保留,标题改成「实盘部署台」,不在侧栏出现。它只做实盘侧操作(晋升、启用、票池轮换),入口是「我的策略 → 部署」页签里的深链 `#strategies?id=<实盘策略 id>`。
- 每条策略的详情有两个页签。
  - 「回测报告」:和原来一样。
  - 「部署」:`#my-strategies?id=<rs_id>&tab=deploy`,分上下两块。
    - 上面是部署状态,只读。显示是否已下发到实盘(lab_strategy_id)、部署模式(关 / 影子 / 模拟 / 实盘限额)、在不在票池、实盘成绩、影子成绩,并有「去实盘部署台操作」按钮。
    - 下面是规则拆分预览:这版 IR 编译成 StrategyBinding 后,按六个角色切片展示。每条规则标明由代码还是模型执行。六个角色是:雷达(什么时候唤醒)、判断 agent(只做入场过滤)、几何(代码放止损止盈)、风控(仓位与杠杆)、持仓(代码管仓)、执行(市价或限价、时效、结转)。编译不了、或者语义有损的规则单列在「未映射」里。
- 列表页的「实盘」胶囊按实盘注册表的真实状态算,不看研究侧 status。读 `/api/strategies` 和 `/api/strategies/allocator`,按 lab_strategy_id 对上;在票池里、或部署模式是模拟 / 实盘的才算。影子不算。
- 五条内置策略以「内置译文」的形式出现在「我的策略」里。它们的 origin 是 import,lab_strategy_id 是内置 id,每条挂一份全窗口回测报告。

## 2. 旧功能的去向

| 策略库里的东西 | 去向 | 说明 |
|---|---|---|
| 策略列表与卡片 | 合并 | 进「我的策略」。实盘那份清单只在实盘部署台看 |
| 手写 rules 自由文本(entry / invalidation / exit 文本) | 删除 | 规则只从 IR 来。实盘现在读的文本在内置策略译成 IR 并接上 apply 之前原样保留,研究台不再读它 |
| 参数手改(params 旋钮) | 改造 | 改参数就是出一个新版本:走研究 loop 的修订、参数扫描或自动改进环,新版本自动挂报告 |
| 归因采纳页(采纳归因 → 草稿新版本) | 改造 | 用「我的策略」的诊断(diagnose_backtest)加改进环代替 |
| EvidenceEditor(手填证据清单) | 删除 | 证据由 IR 原语推导,见 binding.evidence_plan,不再手填(apply-spec §8) |
| lab_stats 晋升统计(Lab 机械漏斗) | 改造 | 研究报告(全窗口 + 样本外分段 + 评分)代替;Lab 参数探针由 parameter_sweep 覆盖 |
| 晋升(draft→backtest→shadow→paper→live_capped)与实盘启用开关 | 留实盘侧 | 在实盘部署台操作;「部署」页签只读展示部署模式 |
| allocator 票池轮换 | 留实盘侧,只读展示 | 部署页签显示是否在票池,以及 allocator 给的原因 |
| 议会投票 / 按策略归因 | 留实盘侧 | runtime.ts 继续按实盘注册表工作,本轮不动 |
| 研究页 B 臂「原策略(策略库版本)」下拉框 | 删除 | apply-spec §8 点名删除。改成「从我的策略载入规则」,载入的是当前版本的 IR,B 臂拿 IR 的名称与描述 |
| 影子成绩、实盘成绩 | 留实盘侧,只读展示 | 部署页签读 lab_stats.shadow 与 eval_stats |

## 3. 分阶段

### 本轮(研究侧,已做)

1. 编译器 `research/strategies/compile-binding.ts`,出 StrategyBinding v1,契约是 §9.47。口径不是自己定的,来自三处现行代码:
   - 订单门用 `order-gate.ts orderGateFor`;
   - 止盈、时效、结转的缺省值用 `orders/intents.ts resolveOrder`,和研究回放调的是同一个函数;
   - 周期用 `horizon.ts`。
2. 只读接口 `GET /api/research/strategies/:id/binding[?version=]`。
3. 内置策略导入 `POST /api/research/strategies/import-builtin {backtest?, ids?}`。按 origin=import 加 lab_strategy_id 判重,重复执行不会重复建。脚本是 `packages/gateway/scripts/import-builtin-strategies.mjs`。
4. 前端:
   - 「部署」页签;
   - 「实盘」胶囊改口径;
   - 侧栏去掉策略库,`#strategies` 标题改成「实盘部署台」,支持 `?id=` 深链;
   - 研究页删掉读策略库文本的下拉框。
5. 五条内置策略的译文见 `research/strategies/import-builtin.ts`,每条缺什么写进 gaps,也就是绑定里 source=import 的 unmapped。

| 内置策略 | 译法 | 主要缺口 |
|---|---|---|
| breakout_retest | 能译,1h | 没有回踩确认原语,改成「突破信号 + 限价挂回踩支撑(structure_level),12 根时效」;不追高和 ATR% 下限没译;只译了做多 |
| mtf_alignment | 能译,15m 触发、1h 确认 | 原来 5m 触发属于 scalp,绑定不接;「突破 / 回踩 / 交叉任一」只留了突破;4h 否决没译 |
| vol_compression_expansion | 能译,1h | 带宽分位用「布林上轨仍低于肯特纳上轨」近似;「只做第一次扩张」和 revert_bars 没译 |
| range_mean_reversion | 部分可译,1h | 回归概率门(reversionStats)没有原语 |
| funding_oi_extreme | 译不了 | 缺资金费率极值、OI 变化、结算时间窗三个原语;只建了「规则未编码」草稿,没有版本 |

### 实盘侧(另一工作线,待做)

1. `POST /api/strategies/apply {strategy_id, version}`:编译 binding,建或更新 `StrategySpec(source:'research')`,写回 lab_strategy_id。要带幂等键、CAS 和 outbox。本轮没做,因为它会碰实盘,需要 Jacky 放行。
2. radar 用 `binding.trigger`;候选生成用 binding 的 stop、targets、min_stop_atr,这一步要和 CandidateV0 对齐;holding-policy 读 trail、breakeven、signal_exits、max_holding_bars;`fitOrderGate` 接到 gates.ts。
3. 部署模式、仓位上限、`model.entry_filter` 的开关放在实盘注册表上,由 A/C 臂配对证据决定。
4. 平仓数据回流到 `research_strategy_versions.live_stats`(apply-spec §6)。
5. 内置策略切到绑定驱动之前,实盘继续跑旧文本版本。部署页签对导入策略写明了这一点。

### 旧页下线时机

`#strategies` 页的旧编辑能力(EvidenceEditor、参数提版本、归因采纳)在两件事都满足后删除:一是实盘侧 apply 上线,二是 breakout_retest 由绑定驱动、跑满一个影子周期(apply-spec §5,shadow n≥20)。删除之后,实盘部署台只剩三样:部署模式、票池、成绩。在那之前页面保留,只是不在侧栏。
