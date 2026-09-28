# 进化页 + 楼层首页 · 设计与接口契约(2026-09-23 夜,jacky-20)

Jacky 拍板「直接开工」。决定：
- 楼层(#floor)就是首页，不另开首页 tab;
- 新开「进化」页(#evolution,放在「回顾」分组),把「记忆」页并进去作为其中一个标签;
- 方格组件做成通用组件，楼层工位卡、判断记录、我的策略都能复用。

## 一、进化的共同底层流程

每个角色都走同一个循环：**记录 → 结算 → 提炼 → 验证 → 采纳 / 回滚**。
- 格子颜色只取「结算」这一步：当天已结算的结果，和该角色自己最近 14 天的基线相比。
- 「提炼 / 验证 / 采纳」是当天的进化事件，比如记忆提案或激活、策略晋升、改进环候选过门槛、prompt 版本变化、参数探针。只在点开格子的明细里列出，不影响颜色。

## 二、颜色口径

- `good` 绿：当天结算结果明显好于基线(或达到角色的绝对好线)。
- `ok` 黄：在基线附近。
- `bad` 红：明显差于基线，或触发了角色的绝对坏线(比如执行失败率 > 10%)。
- `none` 灰：当天没有记录，或还没结算。灰格本身就是信号：说明这个角色还没有反馈回路。
- 基线不足 5 天时，只用绝对线判，并在明细里注明「基线不足」。

## 三、各角色当天指标(以代码里的实际角色名为准)

| 角色 | 当天指标 | 数据来源 |
|---|---|---|
| thread_manager 判断 | 当天已结算判断的事后 R(模型决定 vs 机械对照),判断次数，空转比例 | demo_judgment_ledger、demo_episodes |
| radar 雷达 | 扫描次数，候选被跟进(WATCH/PROPOSE)比例，后续结算为正的比例 | demo_episodes、demo_screen |
| strategy_lab 策略实验台 | 当天研究/回测/改进环运行数，过门槛候选数，策略状态晋升 | research 表、improve_candidates、策略对象 |
| portfolio_manager 组合 | 当天账户收益 vs BTC 持有 | equity 历史 |
| risk_sentinel 风控 | 告警去重后条数，拦截次数，严重告警 | demo_risk_alert |
| executor 执行 | 下单/执行成功率，交易所接口报错数 | episodes 失败、执行回执 |
| reviewer 复盘 | 教训提案数、被采纳数 | demo_memory(kind=lesson)、lessons |
| gate_captain 指挥 | 判断额度使用、模型调用空转比例(票池为空 / HOLD-only 仍调用) | demo_episodes |
| asp_agent 信号市场 | 信号收发与运行成功数 | demo_bot_run、demo_bot_handoff |

每个指标都在后端 `evolution.ts` 里有一个纯函数，阈值写成常量。

## 四、接口(只读，零模型)

`GET /api/evolution/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`(缺省最近 90 天,UTC 日)

```json
{
  "version": "evolution/v1",
  "from": "2026-06-26", "to": "2026-09-23",
  "roles": [
    {
      "role": "thread_manager",
      "label": "判断",
      "metric_label": "已结算判断事后 R vs 机械对照",
      "days": [ { "date": "2026-09-23", "status": "good|ok|bad|none", "score": 0.12, "headline": "12 笔结算，模型 +0.12R vs 机械 −0.05R", "events": 2 } ],
      "summary": { "good": 3, "ok": 1, "bad": 0, "none": 86, "baseline_days": 4 }
    }
  ],
  "today": { "date": "2026-09-23", "equity": "105449.56", "judgments": { "used": 300, "cap": 300, "cost_cny": 2.85, "idle_share": 0.93 }, "live_pool": { "size": 0, "reason": "…" }, "candidates": { "open": 2, "settled": 0 } }
}
```

`GET /api/evolution/day?role=thread_manager&date=2026-09-23`

```json
{
  "role": "thread_manager", "date": "2026-09-23", "status": "good", "score": 0.12,
  "baseline": { "days": 4, "mean": 0.01, "note": "基线不足 5 天，按绝对线判" },
  "metrics": [ { "key": "settled_r_model", "label": "模型决定事后 R", "value": 0.12, "unit": "R" } ],
  "records": [ { "at": 1790150000000, "kind": "judgment", "title": "BTCUSDT scan → 不交易", "ref": "#judgments?episode=…" } ],
  "events": [ { "at": 1790150000000, "kind": "memory_proposed|memory_activated|strategy_promoted|improve_candidate|prompt_version|param_probe", "title": "…", "ref": "…" } ]
}
```

- `records` 最多返回 50 条，按时间倒序;`ref` 是前端 hash 路由，可以为 null。
- 金额用十进制字符串，时间戳用 unix 毫秒，比率用小数。

## 五、楼层首页改动

1. 顶部加一条「今天」:权益、判断额度和花费、空转比例、票池状态(为空时红色，附原因)、影子候选。数据来自 `/api/evolution/daily` 的 `today`。
2. 每个工位卡下面加一条最近 30 天的方格，点击跳到 `#evolution?role=…`。
3. 策略实验台(LAB)的入口从旧策略库 `strategies` 改成「我的策略」`my-strategies`,并显示最近的研究、回测和改进环产出。

## 六、进化页

- 顶部：角色图例，以及各角色 90 天 good/ok/bad/none 的计数。
- 主体：每个角色一行，按月排的方格(Solana uptime 样式);点格子在右侧抽屉看当天明细(指标 / 记录 / 进化事件)。
- 标签页：「进化方格」「记忆」。记忆标签直接复用现有 memory 页组件。
- `#memory` 仍然可以访问，落到进化页的记忆标签。
