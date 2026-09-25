# 长期记忆 B7-lite(v3.2,2026-09-04)

> 09-23 起:**记忆分域**(`docs/design/self-evolution-2026-09-23.md` §5 / §2.2,工单 P0-2)——scope 加 layer/role/strategy_id/thread_id,读写按角色矩阵过滤,被引用的记忆回写结算后果。接口口径见 `v3-ui-contract.md` §9.48。
>
> 回应 Codex 09-04 的记忆评估("交易状态连续性 8/10、长期记忆设计 7/10、实现 2/10")。这份文档是运行时契约;设计层的定位见 `docs/design/trading-swarm-design-v1-2026-09-02.md` §11(L1–L4 分层),接口口径同步在 `docs/demo/v3-ui-contract.md` §9.5。

## 0. 我们采纳/不采纳 Mem0 路线的哪些部分

| 视频/Mem0 的做法 | 这里 | 为什么 |
|---|---|---|
| 主记忆向量库 + embedding | **不做**(先 SQLite + FTS5 trigram BM25 + 结构化过滤) | 语料几十到几百条,实体高度结构化;召回评测证明不足再加 embedding |
| 实体向量库 | **不做**,实体就是字段:symbol / timeframe / regime / tags | 交易实体是有限枚举,普通字段比实体向量更可靠、可测 |
| 每轮结束 LLM 抽取事实 | **不做每轮**;只在**平仓**(代码模板的交易事实)和**显式复盘**(`reflect`,信息员大脑提炼 ≤ 3 条教训)时产生候选 | 每轮写会把判断的自我强化写进长期记忆;§11 也规定"判断过程中没有直接写记忆的工具" |
| hash 去重 | 采纳(归一化后 sha256,精确重复折叠并记 dedup_hit) | 语义去重留给人批时看 |
| 检索:向量 + BM25 + 实体 boost 重排 | 结构化打分(同币 0.3 / 全局 0.15 / regime 0.15 / 周期 0.05 / 标签重叠 ≤ 0.3 / 信心 ≤ 0.2)+ 文本时 BM25 ≤ 0.4;30 天未用衰减 ×0.5;候选 max(K×4, 60) | 同一思路,权重可测可调 |
| 自动注入 / memory_search 工具 | 两者都有:判断前自动结构化召回(≤ 5 条、≤ 600 字);对话有 `recall` 工具 | |
| 写入无门 | **所有写入都是提案**,人批才 active;用户自己在 UI/对话里说的直接 active(用户就是审批人) | §11 硬规则 |
| 删除 | `forget` = tombstone(行保留、事件留痕、召回永不返回);另有 reject / supersede | 视频没讲完的删除流程这里补上 |

保留的交易系统原则(比 Mem0 更严):持仓/价格/余额永远现拉,记忆不能提供;记忆进 prompt 只以证据形式(`E# [记忆 mem-…·教训]`)出现,system 规则 4b 明说"记忆里的数字不是行情数字";eval 把 kind=memory 的证据排除在"数字来源"之外,记忆里的价格被引用会被记成 `memory_number_leak`。

## 1. 契约(`MemoryItem`,`packages/gateway/src/demo/types.ts`)

`id` mem-…;`kind` lesson / preference / fact / calibration;`scope { layer, role|null, strategy_id|null, symbol|null, timeframe|null, regime|null, thread_id|null }`(09-23 分域,见 §1.1);`content` ≤ 300 字;`source_refs`(episode/thread id);`tags`(≤ 12,小写);`confidence` 0–1;`status` proposed → active | rejected;active → superseded | forgotten;`proposed_by` agent / user / system;`supersedes` / `superseded_by`;`created_at` / `decided_at` / `last_used_at` / `use_count` / `expires_at`;`content_hash`;`memory_stats { cited_n, mean_r_when_cited, mean_regret_when_cited }`(09-23,`get`/`list` 读出时从 outcome 事件现算,不落 json)。

历史在 `demo_memory_events`(proposed / approved / rejected / forgotten / superseded / used / dedup_hit / **write_denied** / **outcome**)。表:`demo_memory`(09-23 加列 `layer` / `role` / `strategy_id` / `thread_id`)+ FTS5 `demo_memory_fts(tokenize='trigram')`,迁移 `0006_demo_memory.sql`、`0040_memory_scope.sql`。

### 1.1 分域(layer)

一条记忆属于且只属于一个 layer:

- `global`:所有读 global 的角色都看得到的通用教训。
- `role`:某个角色自己的方法记忆,必带 `role`(如 role:reviewer 的复盘方法、role:portfolio_manager 的 calibration)。
- `strategy`:某条策略的教训/研究日志,必带 `strategy_id`。
- `symbol`:某个币的教训/事实,必带 `symbol`(平仓模板事实落这里)。
- `thread`:某条线程私有,必带 `thread_id`;目前只有 reviewer / gate_captain 读。

`propose` 不给 layer 时推断:有 role → role;有 thread_id → thread;有 strategy_id → strategy;有 symbol → symbol;否则 global。layer 与必带字段不一致 → 400。迁移 0040 回填旧行:symbol 非空 → `symbol`,否则 `global`,json 里的 scope 同步补齐四个新字段。FTS 表是独立表(非 external-content),加列不重建。类型上四个新字段是可选的(兼容 eval-a 等旧构造点),gateway 读出的 item 一律带全。

读写矩阵的单一事实来源是 `memory.ts` 的 `MEMORY_MATRIX`;`bots.ts` 的 `BotProfile.memory_scope` 从自由文本改成 `{read: MemoryLayer[], write: MemoryLayer[], note}`(note 是原来那段说明),`validateRoleBoundaries` 开机比对库里的读写层与矩阵,不一致进程起不来。

| 角色 | 可读 | 可写(提案) |
|---|---|---|
| thread_manager(判断) | global + strategy(仅 `q.strategy_id` 那条;不给则不读 strategy 层)+ symbol | 无 |
| reviewer | 全部(含所有角色的 role 层) | role:reviewer、strategy、symbol、global |
| gate_captain(对话) | 全部 | 全部(role 层只能写 role:gate_captain;用户口述走 `proposed_by='user'`) |
| radar | global + symbol(tag `screen` 加 0.1 分) | role:radar |
| strategy_lab | strategy(给了 strategy_id 只读那条)+ global | strategy、global |
| portfolio_manager | 只有 role:portfolio_manager 且 kind=calibration | 无 |
| asp_agent | global | 无 |
| risk_sentinel / executor | 无 | 无 |

所有读者都照旧受「symbol 不泄漏」约束(见 §3)。

## 2. 生命周期

- **提案来源**:①平仓 → `tradeFactCandidate(thread)`(system,确定性模板:日期 币 方向(来源,周期,日线 regime,触发)→ 盈利/亏损 ±xR,持有 n 分钟;原因)、tags 含 win/loss/stopped_out/触发类型;②`POST /api/memory/reflect` 或未来的 L-daily → 信息员大脑读最近平仓 + 已批准记忆,产出 ≤ 3 条 lesson(agent);③用户在 UI 或对话 `remember` 手写(user,直接 active)。
- **写权(09-23)**:`propose({..., proposed_by_role?})` 先校验写权再去重(越权写入即使内容重复也拒)。`user` / `system` 可写任何层;角色按 §1.1 矩阵,写 role 层只能写自己。拒绝时抛 `MemoryWriteDeniedError`(status 403,code `memory_write_denied`),并落一条 `write_denied` 事件(`memory_id='-'`,detail 是 JSON `{writer, proposed_by, layer, role, strategy_id, symbol, content}`)。**缺省推断是临时的**:没传 `proposed_by_role` 时 `proposed_by='user'` → user,`'system'` → system,`'agent'` → reviewer(现存 agent 写入方只有 reviewer.ts / reviewer-agent.ts / attribution.ts,都是复盘类);调用点显式传角色后删掉推断。thread_manager 永远不能写(判断过程不写记忆,规则不变)。
- **后果回写(09-23,§2.2)**:判断引用了记忆(episode 的 evidence 里 kind=memory 且 ref 在 `judgment.evidence_refs` 里,label `记忆 mem-…·…`;并上 `episode.memory.cited`)→ 该 episode 的判断账本行结算后,`MemoryStore.sweepOutcomes()` 对每条被引用的记忆 `recordOutcome({memory_id, episode_id, outcome_r = outcome_r_model, regret_r = regret_review})`,存为 `outcome` 事件(detail JSON),`(memory_id, episode_id)` 唯一索引保证幂等;`stats(id)` 聚合成 `memory_stats`(均值不含 null;NULL 不是 0)。sweep 还没接进 runtime,见「待接线」。
- **审批**:UI「记忆」页批准/拒绝;`approve` 时若带 `supersedes` 则旧条目 → superseded。
- **使用**:判断引用了记忆证据(evidence_refs 或 reasons 里的 E)→ `markUsed`,episode 记 `memory { injected, cited }`。
- **衰减/过期**:`expires_at` 到期不再召回;30 天未用(按 last_used_at/decided_at)打分 ×0.5,仍可被文本搜索到。
- **遗忘**:`forget` tombstone。

## 3. 召回(`MemoryStore.recall`)

输入 `{ symbol, timeframe, regime, tags, text?, limit=5, char_budget=600, reader_role?='thread_manager', strategy_id? }`。规则:只取 active 且未过期;scope.symbol 为 null 或等于查询 symbol(**跨币不泄漏**;无 symbol 上下文时只给全局);**再按 `reader_role` 过 §1.1 读权矩阵**(strategy 层:给了 `strategy_id` 只读同策略,跨策略不泄漏);有 ≥ 3 字文本时先 FTS5 MATCH 取候选并叠加 BM25(文本召回同样过读权矩阵)。打分新增:同策略 +0.3;radar 读到 tag `screen` +0.1;「全局 +0.15」只给 layer=global 的条目。

**每层配额(09-23,§5.3)**:按 strategy → symbol → global → role → thread 的顺序,每层先取至多 strategy 2 / symbol 2 / global 1 / role 1 / thread 1 条(层内按分数);还有空槽(某层空或不够)再按分数从剩余候选里补满,总数 ≤ limit、字符预算照旧;输出按分数排序。效果:一条高分 global 教训不会再把 5 个槽占满。`reader_role` 缺省 `thread_manager`,所以现存调用点(判断前 recallFor、对话 recall、`/api/memory/search`)行为 = 判断读者;后两者应改传 `gate_captain`,见「待接线」。运行时在每次判断前调用,tags = [symbol, mode, side, source, 触发类型]。

## 4. 接口

`GET /api/memory?status=&symbol=&limit=` → `{items, counts}`;`GET /api/memory/search?q=&symbol=&regime=&tags=` → `{hits:[{item,score,why}]}`;`GET /api/memory/:id` → `{item, events}`;`POST /api/memory {content, kind?, symbol?, regime?, tags?}`(用户,直接 active);`POST /api/memory/:id/approve|reject|forget {reason?}`;`POST /api/memory/reflect {limit?}`(暂停时 409);SSE `memory.changed {id, status}`。对话工具:`remember` / `recall` / `forget_memory`(`set_workflow` 不能碰记忆)。

## 5. 评测(`packages/eval-a`,见其 README)

case 可带 `visible.memories`;`gen-memory` 从已有 case 派生 helpful / poison / irrelevant 三种变体。指标:`memory_number_leak`(硬,=0:只在记忆里出现的数字被写进 reasons)、`memory_command_followed`(硬,=0:指令式记忆导致 PROPOSE)、`memory_citation_rate`、`memory_irrelevant_cited`(≤ 0.1)、`memory_action_flip`。

## 6. 没做 / 边界

- 09-23 分域没做的:`mean_r_same_stratum_uncited`(design §2.2 的对照组)、`superseded` 自动剪枝候选(§5.3,要 cited_n ≥ 8)、情景记忆(fact)不进判断 prompt(§5.1)、calibration 迁出记忆表(§5.1)——都留给后续工单。
- 没有 embedding、没有语义去重(重复但措辞不同的教训要人批时合并 → 用 supersede)。
- reflect 只有手动触发,没有 L-daily/L-weekly 定时;没有"引用计数达到阈值自动升级为 playbook 规则"。
- 校准参数(calibration)只是一种 kind,还没有接到 gates 的阈值上——记忆改数字仍是禁区(§11)。
- Skills / Strategies 两层(§11 下半)未动。

## 7. 待接线(09-23,forbidden 文件里的调用点;API 已向后兼容,不接也照旧跑)

以下文件本工单不能碰(runtime.ts / http.ts 归并行 session),接线时按原样应用:

**① 判断前召回传读者与策略**(`packages/gateway/src/demo/runtime.ts` `recallFor`):

```diff
-      return this.store.memory.recall({ symbol, timeframe: this.workflow.timeframe, regime, tags }).map((h) => h.item);
+      return this.store.memory.recall({ symbol, timeframe: this.workflow.timeframe, regime, tags, reader_role: 'thread_manager', strategy_id: thread?.strategy_id ?? null }).map((h) => h.item);
```

**② 对话 recall 工具按 captain 读全部**(`runtime.ts` 对话工具 `recall:`):

```diff
-      recall: (a) => this.store.memory.recall({ symbol: a.symbol ? String(a.symbol).toUpperCase() : null, text: a.query ?? null, limit: 8, char_budget: 2000 }).map((h) => ({ id: h.item.id, kind: h.item.kind, content: h.item.content, score: h.score, why: h.why })),
+      recall: (a) => this.store.memory.recall({ symbol: a.symbol ? String(a.symbol).toUpperCase() : null, text: a.query ?? null, limit: 8, char_budget: 2000, reader_role: 'gate_captain' }).map((h) => ({ id: h.item.id, kind: h.item.kind, content: h.item.content, score: h.score, why: h.why })),
```

**③ 结算后回写记忆后果**(`runtime.ts` 巡检,紧跟 `settleJudgmentLedger(...)` 那一行之后):

```diff
     await settleJudgmentLedger(this.store, { fetchKlines, limit: 5, log: (level, message, data) => this.log(level, 'ledger', message, data) }).catch((e) => this.log('warn', 'ledger', `判断账本结算失败:${(e as Error).message}`));
+    try { this.store.memory.sweepOutcomes(); } catch (e) { this.log('warn', 'memory', `记忆后果回写失败:${(e as Error).message}`); }
```

(全量扫 + 唯一索引幂等;行数上来后改成 `sweepOutcomes(undefined, { since: 上次水位 })`。)

**④ UI 搜索按 captain 读全部 + 分域过滤参数**(`packages/gateway/src/demo/http.ts`,契约 §9.48):

```diff
-  route('GET', '/api/memory/search', async (_req, res, url) => json(res, 200, { hits: store.memory.recall({ symbol: url.searchParams.get('symbol')?.toUpperCase() ?? null, text: url.searchParams.get('q'), regime: url.searchParams.get('regime'), tags: (url.searchParams.get('tags') ?? '').split(',').filter(Boolean), limit: Math.min(50, Number(url.searchParams.get('limit') ?? '10')), char_budget: 5000 }) }));
+  route('GET', '/api/memory/search', async (_req, res, url) => json(res, 200, { hits: store.memory.recall({ symbol: url.searchParams.get('symbol')?.toUpperCase() ?? null, text: url.searchParams.get('q'), regime: url.searchParams.get('regime'), tags: (url.searchParams.get('tags') ?? '').split(',').filter(Boolean), limit: Math.min(50, Number(url.searchParams.get('limit') ?? '10')), char_budget: 5000, reader_role: (url.searchParams.get('reader_role') as BotRole | null) ?? 'gate_captain', strategy_id: url.searchParams.get('strategy_id') }) }));
```

(http.ts 需要 `import type { BotRole } from './bots.js'` 与 `MemoryLayer` 类型;非法 `reader_role` 值在 recall 里读不到任何层,返回空。)

`GET /api/memory` 的 list 调用加 `layer` / `role` / `strategy_id` 三个可选过滤(`MemoryStore.list` 已支持):`layer: (url.searchParams.get('layer') as MemoryLayer | null) ?? undefined, role: (url.searchParams.get('role') as BotRole | null) ?? undefined, strategy_id: url.searchParams.get('strategy_id') ?? undefined`。`POST /api/memory` 可透传 body 的 `layer / role / strategy_id / thread_id` 进 `scope`(proposed_by='user',写任何层都允许)。

**⑤ 写入方显式传角色,然后删掉 `inferWriterRole` 的 agent→reviewer 推断**:`reviewer.ts` / `reviewer-agent.ts` / `attribution.ts` 的 `propose({...})` 加 `proposed_by_role: 'reviewer'`(attribution 若改归 strategy_lab 则传 `'strategy_lab'` 并带 `scope.strategy_id`);`runtime.ts` 平仓事实 `proposed_by_role: 'system'`、用户 remember `proposed_by_role: 'user'`。

**⑥ webui 类型**:`packages/webui/src/api/types.ts` 的 `BotProfile.memory_scope: string` 已过时,应为 `{ read: MemoryLayer[]; write: MemoryLayer[]; note: string | null }`;`MemoryScope` / `MemoryItem` 同步加 §1 的新字段(UI 目前不渲染 memory_scope,不会崩)。
