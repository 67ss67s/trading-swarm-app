# Graph Engineering v2:把「模型能选的边」显式化(2026-09-03 草案 → **2026-09-04 已落地**)

> 状态:§2 的 `graph.ts` 已实现并接线(`packages/gateway/src/demo/graph.ts`,生成物 `docs/demo/graph.md`,接口 `GET /api/graph`,episode 记录 `graph` 字段);§3 四个指标在 `packages/eval-a` 实现;接口口径见 `docs/demo/v3-ui-contract.md` §9.2。与草案的差别:halted 节点允许集不是空集而是显式 `['NO_TRADE']`;`illegal_action` 记录的是模型的第一次越权输出(线上修一次后 fail-closed)。

设计 v1 §5 的原则是「哪里允许模型选边」。demo v2 里这张图其实已经存在,但散在三处代码里:`context.ts` 决定每轮允许的 action 列表,`threads.ts` 的 `reduceReview` 决定动作→效果,`runtime.ts` 决定事件→触发哪种判断。这份草案把它收成**一张声明式的图**,让运行时、eval、UI 都读同一份。

## 1. 现状(隐式图)

```
节点(判断模式)        允许的模型边                    确定性边(事件)
scan                 NO_TRADE | WATCH | PROPOSE      kline_close / manual / chat → scan(无线程的币)
review:pending_entry HOLD | INVALIDATE               kline_close / info_update / manual → review
review:in_position   HOLD | REDUCE | EXIT | INVALIDATE   order_filled / kline_close / info_update / manual → review
(halted)             (无)                            —
```
动作→效果:PROPOSE→建线程(过闸)、INVALIDATE(pending)→撤单、INVALIDATE/EXIT(position)→平仓、REDUCE→减半、HOLD/NO_TRADE/WATCH→只改论点与 watch_conditions。

## 2. 提案:`graph.ts` + `graph.json`

```ts
interface JudgmentGraph {
  version: string;
  nodes: Record<NodeId, { allowed_actions: Action[]; description: string }>;
  model_edges: { from: NodeId; action: Action; effect: Effect; guards: GuardId[] }[];   // 模型选的边
  event_edges: { event: TriggerKind; when: Cond; to: NodeId }[];                        // 代码走的边
  guards: Record<GuardId, string>;                                                      // 闸的名字 → 说明(实现仍在 gates.ts)
}
```
- `nodeFor(thread | null, halted)` → NodeId;`allowedActions(node)`;`edgeFor(node, action)` → effect + guards。
- `context.ts` 的允许列表、`threads.ts` 的 reduceReview、`runtime.ts` 的效果分发都改成查图;三处不再各写一遍。
- 每个 episode 记录 `graph_version`、`node`、`edge_taken`、`guards_evaluated`,回放时能画出走过的路径。
- 导出 Mermaid 到 `docs/demo/graph.md`(生成,不手改);UI 的判断卡片显示「在哪个节点、选了哪条边、哪些闸放行」。

## 3. 对 eval 的新增指标

| 指标 | 定义 |
|---|---|
| illegal_edge_attempts | 模型输出不在该节点允许边里的次数(现在被 fail-closed 吞掉,应显式计数) |
| edge_coverage | case 集覆盖了图里多少条 model_edge / event_edge |
| guard_hit_distribution | 每个闸拒绝了多少次(哪条闸在真正起作用) |
| path_replay_ok | 从 episode 记录能否无歧义重建 node→edge→effect |

## 4. 顺序

评估完 eval-a / eval-b 并打分之后做:①写 `graph.ts` + 单测;②三处改查图;③episode 加 graph 字段;④eval 加上面四个指标;⑤重跑两套 eval 对比前后。
