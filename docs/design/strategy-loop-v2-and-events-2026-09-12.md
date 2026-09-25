# 策略闭环 v2 · 判断账本 · 策略自定义证据 · 事件区(2026-09-12)

Jacky 09-12 提的五件事的设计与派工。前置:09-09 Codex 复审的 must-fix(撤单事实链 P0、议会钳降、mergeVerdict、range 取数、tick 整数对齐、Radar 票池、cap 出队复查、方向/时机拆裁决)在三个 worktree 并行修,本文的实现都建立在那批合并之后。

## 0. 现状一句话

策略库有五条,只有 `breakout_retest` 在 paper 真跑;Lab 零模型漏斗每 7 天/≥10 笔平仓跑一次,能把 draft→backtest→shadow 自动推,paper 以上永远人批;判断 prompt 把启用策略的 checklist 塞进证据,PROPOSE 必带 strategy_id;平仓后 attribution 只出记忆提案。缺的是:**没有"找策略"这一步、shadow 没有实盘影子数据、paper 门只能人批、复盘分不清"策略不行"还是"模型判断不行"、证据是固定一套不按策略选、事件只有新闻摘要没有生命周期**。

## 1. 策略 agent 全自动闭环 v2

```
发现(hypothesis) → 起草(draft) → 漏斗回测(backtest) → 影子实盘(shadow) → 纸面(paper) → 限额实盘(live_capped)
      ↑                                                                                    │
      └──────────── 复盘归因(attribution) → 参数/规则升级提案 → Lab 验证 → 新版本 ←───────────┘
                                                            退役(retired)  ←  连续劣化
```

### 1.1 发现:三个来源,统一产出 StrategySpec draft

| 来源 | 触发 | 模型 | 产出 |
|---|---|---|---|
| 参数探针(已有) | Lab 每轮 | 无 | 同族新版本 draft |
| 复盘教训 → 假设 | Reviewer 批次后,每周 ≤1 次 | 便宜大脑 1 次 | ≤3 条新 family/变体 draft |
| Radar 行情缺口 | Radar 周线跑完 | 无 | 「当前 regime 下没有一条策略够格」的缺口记录,喂给上一行 |

假设生成的硬约束:输出必须是合法 `StrategySpec`(schema 校验),`checklist.required` 全部是指标库能算的 id,`measurableByFunnel` 必须为真(量不出来的假设直接丢,不进库),内容哈希判重。模型只能提 draft,状态机不给它任何晋升权。

### 1.2 晋升门(全部代码判,paper 门自动化)

| 迁移 | 门 | 判者 |
|---|---|---|
| draft → backtest | schema 合法 + 漏斗可量 | 代码(已有) |
| backtest → shadow | lab n≥20 且期望 ≥ +0.1R | 代码(已有) |
| shadow → paper | **影子实盘** n≥20、期望 ≥ +0.1R、与 lab 期望差 ≤ 0.3R(数据一致性)、最大回撤 ≤ 3R | 代码(**新**) |
| paper → live_capped | eval_stats(含模型回放)n≥30 期望 ≥ +0.15R + 人批 | 人(保留) |
| 任意 → retired | 最近 30 笔期望 < −0.1R 或 连续 10 笔亏 | 代码(**新**,降级不退役到 backtest 重来) |

**影子实盘**(shadow live)是关键新件:shadow 状态的策略也参加每次扫描的议会表态,当它单独给出方向且时机 confirmed 时,建一条**虚拟线程**(`thread.kind='shadow'`,不下单、不占容量、不进风控),按真实 K 线结算 R,写回 `lab_stats.shadow`。这样 shadow 期的数字来自与 paper 完全相同的触发/证据/时序,不再是漏斗的近似。

### 1.3 升级
attribution 现在只出记忆提案。改成结构化:`AttributionProposal.kind ∈ {param, rule_wording, checklist_item}` 已有,加落地路径——`param` 类直接进 Lab 探针队列(下一轮验证),验证达标才 `createVersion`;`rule_wording`/`checklist_item` 类仍走记忆人批。每条策略每版本记 `strategy_events` 台账(谁触发、依据数据、前后状态),策略页画晋升时间线。

### 1.4 派工
`strategy-loop.ts`(新,状态机 + 门 + 台账)、`strategy-hypothesis.ts`(新,假设生成 prompt + 校验)、strategies.ts(shadow 字段、retire 逻辑)、strategy-lab.ts(探针队列吃 attribution)、runtime(虚拟线程结算)、routes-strategies(台账/时间线接口 §9.27)。opus 一包。

## 2. 上线策略切换给 agent 真跑

`workflow.active_strategies` 已可改。补三条语义,写进契约 §9.28:
- 只有 `paper`/`live_capped` 状态的策略能进 active;状态退化时自动移出并告警(warn,带「重新启用」action)。
- 切换不影响在途线程:线程钉自己开仓时的 `strategy_refs`,复查按钉住的版本算;新线程用新集合。
- 议会票池 = active 全集(Radar 候选只做优先,见 must-fix #5)。
UI:策略页一键「启用/停用」+ 状态徽章,盯盘参数页显示当前票池。这包小,并进第 1 包。

## 3. 判断准确度复盘(把"模型判断"从"策略"里剥出来)

**要不要走测试?不用付费测试。** 用真实 episode 加代码反事实就能量,零模型成本;付费 eval 只在改 prompt 时跑。

每个 episode 落一行 `judgment_ledger`:

| 列 | 来源 |
|---|---|
| model_action / model_dir | Judgment |
| council_dir / council_agree | 议会代码裁决(零模型) |
| mechanical_dir | eval-a 的 `mechanicalFor` 搬到 gateway(突破方向 + 0.8 ATR 止损 + 1.5R,48 根) |
| outcome_r_model | 线程结算(已有 settlement),无线程时用反事实结算 |
| outcome_r_council / outcome_r_mechanical | 代码按各自方向反事实结算(同 horizon) |
| regret_review | 复查 HOLD/EXIT 的反事实(已有 counterfactual 逻辑搬过来) |

周报指标(Reviewer 批次里代码算,不用模型):`judgment_alpha = mean(R_model − R_council)` 按策略分层、`override_rate`(模型与议会不一致的比例)与 `override_alpha`(不一致时谁对)、复查 regret。**结论口径**:alpha ≈ 0 且 override_alpha < 0 → 模型没有增量,该关掉模型让议会直接下单(省钱);alpha > 0 只在某族 → 模型只在该族用。

派工:`judgment-ledger.ts`(新)+ runtime 落库钩子 + `GET /api/judgment-ledger/summary`(§9.29)+ 复盘页一张表。opus 一包,与第 1 包无文件重叠(只加 runtime 一处钩子)。

## 4. 策略自定义指标/事件(减黑盒)

`StrategySpec` 加 `evidence` 段:
```ts
evidence: {
  indicators: { id: string; tf: string; params?: Record<string, number> }[]; // 指标库 id(routes-indicators 的 34+7)
  events: TriggerKind[] | EventKind[];      // 只对这些事件醒
  info_topics?: string[];                   // 信息员新闻主题过滤(如 'etf','listing','macro')
}
```
context.ts 装证据时**只按启用策略的 evidence 并集**装,每条 Evidence 带 `required_by: string[]`(哪几条策略要它);判断记录页每条证据标来源。没有策略要的指标不进 prompt(缩 token,也让"模型看到了什么"可解释)。策略编辑器(前端)用指标库列表做多选。兼容:没写 evidence 的旧策略用今天的默认集。

派工:与第 1 包同一个人(都改 strategies.ts/context.ts),放在第 1 包之后做。

## 5. 事件区(Event Zone)

Jacky 原话:信息员自动 capture/复盘 → event;timer → 想法设法拿一手信息 → 成为开单依据。

### 5.1 事件实体
```ts
interface MarketEvent {
  id; kind: 'scheduled' | 'news' | 'exchange' | 'onchain' | 'derived';
  subkind: string;            // fomc / cpi / unlock / listing / delisting / funding_extreme / etf_flow …
  assets: string[];           // 空 = 宏观
  expected_at: number | null; // scheduled 才有
  window_ms: number;          // 影响窗口
  captured_at; source; source_ref; confidence: 'confirmed' | 'reported' | 'rumor';
  status: 'captured' | 'briefed' | 'live' | 'resolved' | 'retro_done';
  brief: { at; text; refs[] } | null;    // T−N 的一手信息简报
  impact: { move_1h_pct; move_4h_pct; move_24h_pct; realized_vol_ratio } | null; // 复盘回填
  used_by: string[];          // episode ids
}
```

### 5.2 生命周期
1. **capture**:三路进——信息员抓到的新闻按规则分类成 event(关键词表 + 资产映射,零模型;分不清的给便宜大脑一次);日历源(FOMC/CPI/NFP 静态表 + 代币解锁/上币公告 RSS);派生事件(资金费率极端、OI 突变,triggers 已有,升格成 event 记录)。
2. **timer → brief**:scheduled 事件在 T−60m 与 T−10m 两次「拿一手信息」:定向拉官方源/交易所公告/衍生品指标,让信息员出一段 brief(便宜大脑,每事件 ≤2 次);brief 写回 event,并作为**高相关新闻证据**进该资产的下一次判断。
3. **live**:事件窗口内该资产的判断触发器带 `kind:'event'`,策略 `evidence.events` 含该 subkind 的才醒;窗口内闸:`event_blackout`(可配置的事件前 N 分钟不开新仓)。
4. **resolve → retro**:窗口结束后代码回填 impact;同 subkind 的历史 impact 聚合成「这类事件的历史命中率/平均波动」,作为证据附在下一次同类事件上(事件也有 lab_stats)。
5. **成为开单依据**:不是让事件直接下单,而是让它成为议会里的一票——新策略族 `event_driven`(如"解锁前 24h 做空/上币首日冲高回落"),走第 1 节同一条晋升阶梯,量得出才上。

### 5.3 派工
`events.ts`(新:实体、分类器、日历、impact 回填)、info.ts(capture 钩子)、triggers.ts(event 触发种类)、runtime(timer 与 brief 调度)、`routes-events.ts`(§9.30:列表/详情/手动补录/标记)、前端 `#/events` 页。opus 一包;与第 1/3 包无重叠(triggers.ts 只加枚举)。

## 6. 实施顺序

1. 第一波(进行中):must-fix 三 worktree → 合并 → 全量测试 → **paper 通道重启跑一周对照**(Codex 建议的三段式,不直接切真钱)。
2. 第二波并行:第 3 包(判断账本)+ 第 5 包(事件区)。
3. 第三波:第 1+2+4 包(策略闭环 + 切换 + 自定义证据,同一人)。
4. 前端:策略时间线、账本表、事件页,契约 §9.27–9.30 写好后派 webui session。

不做:让模型直接管晋升;事件直接触发下单;live_capped 自动化。
