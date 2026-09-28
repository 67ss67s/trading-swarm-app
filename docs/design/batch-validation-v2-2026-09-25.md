# 批量验证 v2(2026-09-25)— §9.53 B 契约增补草稿

状态:已在 worktree `wt/strategy-loop`(<repo>)实现并过测试,**未提交、未部署**。本文是给 `docs/demo/v3-ui-contract.md` §9.53 B 的增补,由 Claude 合进契约(这次没有直接改契约文件,另一个会话在改它)。

## 1. 为什么改

18811 上 09-25 跑的 6 次批量验证全部「没找到」,主因 100% 是样本不足(选择段平仓 < 30 笔),可结果地图里不少格子选择段 +10% ~ +25%。v1 的笔数门槛一刀切,好组合没有下一步可走。v2(B 方案):

- 每格一张统一评分卡(与研究台 / 我的策略同一个评分函数);
- 结论分三档,新增「候补 · 可纸面观察」;候补可以「存为候补策略」,去我的策略里用模拟盘跑前向;
- 原来的正式门槛(含留出段最终验收)**一条不删**,「通过」的意思不变;
- 和研究台打通:结果地图每一格可「在研究台继续打磨」。

## 2. 评分卡(每个有成绩的试验一张,读视图重算)

口径:**直接复用 `research/analyzer.ts` 的 `score()` / `scoreLabel()`**(研究台 BacktestScore,0-100,label = excellent / good / fair / needs_work / poor,六个分项与权重不变)。

| score() 入参 | 批量验证里喂什么 |
|---|---|
| 主指标 `m` | 选择段:total_return、cagr(按选择段窗口 `cagrOf`)、max_drawdown、sharpe、win_rate、profit_factor、expectancy、trades、excess_return = 收益 − 同期持有 |
| `segments.in_sample` / `out_of_sample` | 训练段 / 选择段(给 oos_stability) |
| `benchmark_cagr` | 选择段同期持有的年化 |

- 同敞口持有、手续费占比(手续费 / 毛收益)、2 倍费率收益另列在卡上,不进分数(同敞口持有是候补硬条件)。
- 盈亏因子:v2 起 `DevResult` 新增可选 `selection_profit_factor` / `train_profit_factor`(段内成熟交易单笔收益,与 analyzer 同口径,没有亏损 → null)。**v2 之前的评估没有这个字段**:profit_factor 分项按中性 50 计(与 score() 对缺基准 / 缺分段的处理同法),卡的 `notes` 写明。
- **留出段一律不进评分卡**:入参只有训练 / 选择段 SlimScore 与选择段日收益;测试断言换掉留出成绩评分卡逐字不变、卡里没有 holdout 字段。

`MatrixScorecard`(`cells[].result.scorecard`):

```ts
{
  version: 'matrix_scorecard_v1'; trial_id: string;
  score: BacktestScore;                       // value / label / confidence / confidence_reason / components
  metrics: { total_return; max_drawdown; sharpe; win_rate; trades; profit_factor; expectancy; cagr; days;
             hold_return; exposure_matched_hold; excess_vs_hold; excess_vs_matched_hold; stressed_return;
             fee_share /* 手续费 / 毛收益,毛收益 ≤ 0 → null */; fees_pct };
  train: { total_return; sharpe; trades; max_drawdown; cagr } | null;
  luck: LuckDiscount;
  segments: ['train', 'selection'];
  notes: string[];
}
```

### 运气折扣 `LuckDiscount`

```ts
{ method: 'dsr' | 'bonferroni' | 'unavailable';
  cell_trials; study_trials; program_trials;   // 本格 / 本研究 / 全谱系看过成绩的试验数(都记账)
  dsr;          // 与正式门槛同口径:全谱系 trial_count + 本研究选择段夏普方差(stats.dsrOf)
  dsr_cell;     // 只按本格试验数折算(敏感性)
  p_value;      // 选择段日收益均值 > 0 的单侧检验(正态近似)
  p_bonferroni; // min(1, p × program_trials)
  luck_probability; // dsr 可用 → 1 − dsr;否则 p_bonferroni
  text }        // 白话:「试了 N 个版本(本格 n、这次研究 m);按这么多次试验折算,这组选择段成绩约 X% 的可能是运气」
```

## 3. 三档 `tier`(`cells[].result.tier`,读视图重算)

| tier | 规则 |
|---|---|
| `pass`(通过) | 原门槛全过 + 最终验收通过(finalist.passed = true),意思不变 |
| `pending`(等最终验收) | 选择段全过、在 finalist 名单里还没验收;或搜索还没封存时选择段全过的试验 |
| `paper_candidate`(候补 · 可纸面观察) | 选择段净收益 > 0、跑赢同敞口持有、回撤 ≤ protocol.max_drawdown、评分卡 ≥ fair、没有 unsupported_execution / 数据缺失(没成绩),**没过的门槛只能是** `selection_trades>=` / `selection_blocks>=`(样本数)和 / 或 `deflated_sharpe>=`(显著性);选择段全过但没进 finalist 名额(top_k)的也算候补 |
| `fail`(未通过) | 其余;含最终验收没过的 finalist,以及**同格 finalist 最终验收没过时同格的其它变体**(留出结果只能否决,不能加分) |
| `ineligible` | 不适用 / 仅研究 |

每格取最高档(pass > pending > paper_candidate > fail);候补档里按评分、再按选择段夏普挑一个 `tier_trial_id`(可能不是 `best_trial_id`);未通过的格子沿用原 `best_trial_id`。另有 `tier_reasons: string[]`(候补时是「平仓 7 笔,不到 30 笔;显著性不够(DSR 0.00,门槛 0.95)」这类白话)。

旧字段 `verdict / cause / gates / dsr / selection` 全部保留不变。

### 结论(`conclusion`,向后兼容)

- `kind` 枚举**不变**:`'passed' | 'no_candidate'`(有候补没通过仍是 `no_candidate`)。
- 新增可选:`paper_candidates: number`、`paper_candidate_trial_ids: string[]`、`tiers: Record<tier, number>`。
- `text`:有候补且没通过时 →「没有能直接上实盘的策略,但有 N 组值得先用模拟盘看看:候补 N 组(只差样本数 / 显著性,可先用模拟盘观察;候补不算通过)。…主因分布…」;有通过时追加「另有候补 N 组」;没候补时与 v1 相同。
- 读视图对旧研究也按三档重算结论(`kind` 取存量值);完成时写库的结论、`complete` handoff payload 也带 `paper_candidates` / `paper_candidate_trial_ids`。

## 4. 新接口

### `POST /api/research/matrix-studies/:id/adopt-candidate {trial_id, name?}`

- 只收 `status = completed` 的研究里 `tier = paper_candidate` 或 `verdict = near` 的试验;finalist 请走原 `/adopt`(`candidate_is_finalist`);同格 finalist 最终验收没过 → 拒(`candidate_not_allowed:cell_failed_final_validation`)。
- 与 finalist adopt **同一条保存路径**(`saveStrategy`):内置族 → 新建「我的策略」(名字带「候补」);「我的策略」行 → 该策略新版本(同 IR 不重复建版本,资产 / 周期跟到这一版);运行器预检照做,blocker 整笔回滚。
- 标记「未经最终验收」:
  - 描述 / 版本 note 前缀 `[批量验证候补 <study_id> · 未经最终验收 · horizon=… · <family>/<side>/<arm> · 来源:…]`,正文带选择段成绩、评分、运气折扣、档位原因;
  - `research_matrix_adoptions.finalist_id = 'candidate:<trial_id>'`(不加迁移;据此键前缀判断未经最终验收);
  - handoff `adopt:candidate:<trial_id>` payload `{kind:'paper_candidate', final_validation:false, trial_id, score, score_label}`;outbox 事件 `adopted.kind = 'paper_candidate'`。
- **不自动启动运行**。返回:`{strategy_id, version, preflight:{deployable, warnings}, horizon, source, kind:'paper_candidate', final_validation:false, trial_id, tier, scorecard:{value,label,luck}, next:{link:'#my-strategies?id=…', text:'去我的策略里用模拟盘跑起来'}}`。
- 幂等:同一研究同一试验再调返回同一策略。
- 错误:404 `trial_not_found` / `matrix_study_not_found`;409 `matrix_study_conflict:<status>`、`candidate_not_allowed:*`、`candidate_is_finalist:*`、`adopt_preflight_blocked:*`;400 `trial_id_required` / `name_invalid`。
- 已有 `POST /:id/adopt {finalist_id}` 行为不变(实现改成共用 `saveStrategy`,描述前缀仍是 `[矩阵研究 `)。

### `GET /api/research/matrix-studies/:id/trials/:trial_id`

研究台深链用:`{study_id, trial_id, cell:{id,symbol,timeframe,horizon,family,family_name,side,arm,market}, ir, tier, reasons, verdict, scorecard, adopted}`。只含训练 / 选择段,不含任何留出信息。

### 详情视图新增

- `cells[].result.{tier, tier_trial_id, tier_reasons, scorecard}`;
- `candidate_adoptions: [{trial_id, adopted:{strategy_id, version}}]`;
- `conclusion.{paper_candidates, paper_candidate_trial_ids, tiers}`。

## 5. 对话工具

- `adopt_matrix_candidate {study_id, trial_id, name?}` → 同 HTTP,附 `note` 与 `link`。实现挂在 `runtime.ts` 的 `chatTools()` 返回对象里(对话按名字分发,可用)。
- `get_matrix_study` 结果新增 `paper_candidates[]`(≤12 条,按评分降序:trial_id / 资产 / 周期 / 族 / 方向 / 臂 / 原因 / 评分 / 选择段收益 / 笔数 / 回撤 / 运气折扣)与 `paper_candidate_note`(告诉模型候补不算通过、用户同意后才调 `adopt_matrix_candidate`、存完引导去模拟盘)。
- `onConclusion` 回报对话:有候补时标题改成「没有能直接上实盘的,但有 N 组值得先用模拟盘看看」;`onAdopted` 候补时说「未经最终验收,没有自动运行,去我的策略里用模拟盘跑起来」。
- **待主树补**(chat.ts 本次禁改):`ChatTools` 接口加 `adopt_matrix_candidate?`,`TOOL_DOC` / `STRATEGY_LOOP_SKILL` 第 3、4 条加一句「结论有 paper_candidates 时说『有 N 组候补可先模拟盘观察,不算通过』;用户同意 → adopt_matrix_candidate」。在此之前模型靠 `get_matrix_study` 结果里的 note 知道这个工具。

## 6. 前端

- 结果地图按三档上色(候补用 primary 蓝色、等验收浅绿);旧后端没有 `tier` 时仍按 v1 通过 / 接近 / 未通过。悬停显示评分与运气折扣,点开一格弹右侧抽屉:指标表(选择段收益、同期持有、同等仓位持有、回撤、夏普、胜率、笔数、盈亏比、每笔期望、手续费占毛收益、2 倍费率、训练段)、运气折扣、评分分项、「存为候补策略」(存完显示「去我的策略里用模拟盘跑起来」链接)、「在研究台继续打磨」。
- 研究台深链:`#research?matrix_study=<id>&trial=<trial_id>` → 研究台取 `/trials/:trial_id`,把 IR + 周期 + 一句描述带进「策略构建」,顶部横条「从批量验证带过来 … 回到批量验证」;读完把参数从地址栏去掉。研究台原有「用批量验证测这条」不变。
- 两边页面顶部一行分工说明:批量验证 = 海选(还不知道做哪个币 / 周期 / 策略);研究台 = 精修(已有想法,逐条改)。
- 结论卡:notes 去重;`resume → queued`、「进程重启…」「已取消…」这类过程事件从结论区移到「技术信息」折叠。标题按三档:通过 / 「没有能直接上实盘的,但有 N 组值得先用模拟盘看看」/ 「这次没有找到能用的策略」。列表页有候补时显示「候补 N 组」。
- 我的策略切换弹层:描述前缀 `[批量验证候补 ` → 来源标签「批量验证 · 候补」(虚线蓝框);`[矩阵研究 ` 仍是「批量验证」。

## 7. 已知风险 / 待拍板

- **很多候补只有 1–7 笔**:18811 上 6 次研究按 v2 重算,候补 35 / 13 / 20 / 3 / 2 / 27 组,其中不少选择段只有 1–2 笔平仓却评到 excellent(`score()` 本身不按笔数降分,只给 confidence=low)。运气折扣在这些格子上是 0.8–1.0,卡上写得清楚,但地图上它们和 20 笔的候补同色。是否给候补加最低笔数(例如 ≥ 5)或要求 confidence ≠ low,需要 Jacky 拍板(本次按 B 方案原文,没加)。
- 盈亏因子对 v2 之前的研究按中性计,新跑的研究才有真实值。
- 读视图每次按 `updated_at` 缓存重算(从 `research_study_evaluations` 读 dev 行);200+ 试验的研究首次打开多一次 JSON 解析。

## 8. 预算与两段式 Jev(2026-09-26)

起因:18811 上海选实测 6 币 × 15m × 6 族 × 多空 × 纯代码 + Jev = 420 个变体(上限 300)、判断约 96,810 次(上限 20,000)、预留 $14.52(上限 $1),三个维度一起超;10 个币直接 `symbols_invalid`(上限 6)。后端过去只在 estimate / create 时报错,前端要等填完才估算。三层改法:边选边估、一键修正、Jev 两段式。

### 8.1 spec 新增(`POST /estimate`、`POST /` 共用;未知字段仍报错)

| 字段 | 取值 | 缺省 | 说明 |
|---|---|---|---|
| `judge_stage` | `'all'` \| `'candidates'` | `'all'` | 不传 = 旧行为(每格两臂一起跑);旧研究的 spec 没有这个字段,一律按 all 读 |
| `judge_stage_max_cells` | 1..48 | 12 | 只在 `candidates` 下可传,否则报 `judge_stage_max_cells_requires_candidates` |
| `origin.batch` | `{id, index, total}` | 无 | 前端「自动拆批」给同一批海选打标记;id `[A-Za-z0-9_.:-]{1,80}`,1 ≤ index ≤ total ≤ 50;只做标记,不参与计算 |

归一化后的 spec 总带 `judge_stage`;`judge_stage_max_cells` 只在 candidates 下出现;`origin` 只在给了 batch 时才多 `batch` 键(旧形状 `{chat_session_id}` 不变)。新建表单缺省传 `candidates`;API / 对话工具不传时仍是 `all`。

### 8.2 manifest 冻结的规则

`judge_stage = 'candidates'` 时,manifest 多一个 `judge_stage`(写库即冻结,`research_matrix_studies.manifest_json` 有触发器),并进 `protocol_hash`(all 模式不加键,旧哈希不变):

```ts
{ version: 'judge_stage_v1', mode: 'candidates', max_cells: K,
  eligible: 'code_cell_verdict_pass_near_or_tier_pending_paper_candidate',
  rank: 'scorecard_desc_tier_sharpe_cell_id',
  variants: 'manifest_variants_same_param_as_generation0_code_trial',
  timing: 'after_code_search_before_seal' }
```

manifest 里 code_judge 格照常展开(applicability、变体、分段都冻结);两段式只决定「跑哪几格」,不新造 IR。

### 8.3 阶段推进

`data → matrix → iterate → (两段式补跑) → sealed → holdout → done`,补跑不是新 stage,仍在 `iterate` 阶段之后、封存之前,进度 note 写「Jev 两段式」:

1. **第一阶段**:`runMatrix` 只跑 code 格(code_judge 格跳过);迭代环照旧只会挑有成绩的格子,所以也只在 code 格上迭代。
2. **入选**(一次算定):用第一阶段全部 code 试验按正式口径(`judgeTrials` + `cellResults` + `tierBoard(sealed=false)`)评定。某个 code_judge 格入选的条件:对应 code 格 `verdict ∈ {pass, near}`,或三档 ∈ {pending(选择段全过、尚未封存), paper_candidate};排序:评分卡分数降序 → 档位 → pass 优先 → 选择段夏普降序 → cell_id;取前 K 格。名单写进 `state.judge_stage = {mode, max_cells, status:'selected', eligible, selected:[{cell_id, code_cell_id, code_trial_id, param, score, tier, verdict}]}`,**resume 复用名单,不因谱系试验数变化重算**。
3. **补跑**:每个入选格只跑 manifest 里与「代表性第 0 代 code 试验」同 `param` 的 code_judge 变体(代表性试验 = 该格决定档位的试验,若它不是第 0 代则取第 0 代里最好的;有 `judge_templates` 时是该 param 的全部模板,仍按模板组先训练段选赢家)。走同一个 `evalTrial`:同一开发视图(data_lock 不变)、同一 manifest、先登记再评估,`selection_visible_at` 照常写,计入 `trial_count` / `study_trial_count` / DSR;变体预算、墙钟、判断预算的检查不变。完成后 `status:'done'`。
4. **封存 / 留出 / adopt**:完全不变。finalist 仍是「全部 verdict=pass 试验按选择段夏普取 top_k」,补跑的 code_judge 试验可以进;封存时的 `trial_ledger_hash` 已包含补跑试验;留出段仍一次释放全部 finalist、Holm 一次校正;adopt / adopt-candidate 语义不变。

### 8.4 结果与读视图

- 没入选的 code_judge 格:`cells[].result = {verdict:'ineligible', cause:null, judge_stage:'not_candidate', gates:[{name:'judge_stage:not_candidate'}]}`;第一阶段还没结束时是 `judge_stage:'pending'`;补跑过的格子 `judge_stage:'rerun'`,其余字段照常(含 `judge_delta`)。
- 三档:没补跑的 code_judge 格记 `ineligible`,不进候补 / 未通过计数。
- 结论:没补跑的格子不算「可评估格子」、不进主因分布;`conclusion.judge_stage = {mode:'candidates', rerun_cells, eligible, skipped_cells}`,`text` 里带「Jev 两段式:只对候补测了 Jev,补跑 N 格」。Jev 效果图天然只含补跑过的格子(其余 `judge_delta = null`),前端另加注「只对候补测了 Jev」。
- 详情 / 列表视图顶层新增 `judge_stage`(= `state.judge_stage`,all 研究为 null)。

### 8.5 估算口径(`POST /estimate`)

原字段含义不变,新增:

```ts
estimate: {
  stage1_trials: number;              // 纯代码臂变体;all 模式 = matrix_trials
  judge_stage: { mode: 'all'|'candidates'; max_cells: number|null; judge_cells: number; trials_max: number; calls_max: number };
  budget: { variants:{value,limit}; judge_calls:{value,limit}; judge_usd:{value:string,limit:string}; symbols:{value,limit:6} };
  over: ('variants'|'judge_calls'|'judge_usd'|'symbols')[];   // 超了的维度
  near: 同上;                                                  // > 80% 且没超
  judge_call_usd: string | null;                              // model_profile.max_call_usd
}
cells[].judge_calls: number   // 该格按 all 模式的判断粗估(code 格为 0)
```

- 单格判断粗估不变:变体数 × ⌈(选择段末 − 训练段首) / 周期 / 30⌉(15m 180 天约 461 次 / 变体)。
- all:`matrix_trials` = 全部格子变体,`judge_calls` = 全部 code_judge 格之和(与以前一致)。
- candidates:`matrix_trials = stage1_trials + trials_max`;`judge_calls = calls_max` = 可补跑格子(code 格与 code_judge 格都可评估)里单格判断最多的 K 格之和(最坏情况);`trials_max` 取变体数最多的 K 格。`judge_usd` = 调用 × 单次预留价。
- `within_budget` 语义不变(只看变体数,`create` 仍只因它拒绝);`over` / `near` 给前端逐维度上色与修正建议。币数 > 6 在 spec 层就 `symbols_invalid`,前端静态判断并拆批。
- 实测那组 6 币 × 15m 在 candidates(K=12)下:变体 = 210 + 12 = 222,判断 ≤ 12 × 461 = 5,532 次,预留约 $0.83,三个维度都在预算内;10 个币拆 2 批各 5 个也都在预算内(见 §8.7 核对)。

### 8.6 前端

- 边选边估:表单改动防抖约 300ms 调 estimate,保留上一次结果;估算条逐维度显示组合数 / 变体 / 上限、Jev 调用与预留美元(两段式写最坏 K 格)、预计耗时;> 80% 黄、超了红,并写明哪个维度超。会让预算超标的选项按当前估算静态投影(币 / 族 / 方向按比例放大,周期按单变体判断公式,加 Jev 臂按当前模式),给出「再加这个会超 X」。
- 一键修正(最多 3 个,每个先调 estimate 验证再显示修正后的数字,点了应用到表单):Jev 两段式 > 自动拆批(每批 ≤ 6 币、每批 `over` 为空,必要时连同两段式;前端串行创建 N 个海选,`origin.batch` 标记,列表显示「批次 i/N」)> 减维度(去做空 / 去一个周期 / 少两个族,挑降幅最大的)。任一维度超标时「开始」按钮禁用。
- 新建表单缺省 `judge_stage:'candidates'`,选了 Jev 臂时可切回「每组都测 Jev」。详情页 Jev 效果区与结果地图注明「只对候补测了 Jev」,没补跑的格子显示「未测 Jev」而不是「不适用」。

### 8.7 已知风险

- 两段式的 Jev 效果只来自第一阶段表现好的格子,是**有选择的子样本**:它回答「在纯代码已经不错的格子上 Jev 有没有增益」,不能外推到全部格子。结论文本已注明。
- 入选时 DSR 用的是当时的谱系试验数;名单一次算定后冻结,之后补跑再增加的试验只影响最终门槛,不回头改名单。
- 最坏估算按「单格判断最多的 K 格」,真实补跑格数常少于 K,实际花费通常更低;预留仍按单次上限原子预留。
