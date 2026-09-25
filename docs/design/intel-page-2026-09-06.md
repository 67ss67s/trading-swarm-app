# 信息员页(#intel)重构 — 2026-09-06(Codex astra 方案 + 我的处置,待 Jacky 拍板)

来源:内部评审记录;现状 `packages/webui/src/pages/intel.tsx`(头部徽章 + 总览/历史两个 tab,新闻在总览里)。

## 1. 定位与边界

信息员 = RADAR 角色的**情报工作台**:解释「环境发生了什么、证据是什么、下一步看什么」。
- 楼层 RADAR 桌只看状态与交接;信息员页讲环境;筛选页管排名、策略匹配、应用名单——信息员里的「候选」改叫「关注线索」并链接到筛选页,不做第二个筛选页。
- Agent 页状态条那一句话摘要就是本页顶栏同一份,点它跳到本页对应证据。

## 2. 页面结构(单页,从上到下,不再嵌套 tab)

1. **顶栏**:一句话态势 · 更新时间(过期/失败常显红黄)· 立即总结 · 频率抽屉 · 来源管理入口。回答「新不新鲜」。
2. **首屏重点**:三条 key_points + 风险事件,默认展开。回答「先看什么」。
3. **主栏 新闻流**:默认按时间,可切「高相关」;每条 = 标题(可点原文,新窗)· 来源描边徽章 · 发布时间 · 相关度(标「相关度」不是可信度)· digest(标「模型解读」,默认两行可展开)· 「拿去问 Agent」(预填事件引用/标题/URL/digest 到对话草稿,用户自己发)。无有效 http(s) 链接的标「原文缺失」。「无新闻」与「采集失败」分开显示。
4. **侧栏(窄屏顺排)**:主流币明细 / 情绪 / 异动,默认收起。回答「数据支持吗」。
5. **底部折叠**:偏向历史时间线 / 原始事件表。回答「为什么变了」。
视觉沿用全站 A+B 融合(kicker 面板头、单强调色、紧凑)。

## 3. 新闻源

- 两源(coindesk / cointelegraph)够 demo,覆盖偏窄。默认七源建议:CoinDesk、Cointelegraph、Decrypt(英文);PANews、律动 BlockBeats(中文);美联储 feeds、以太坊基金会博客(一手宏观/协议)。接入前逐个试抓;跨源去重;每源限额;低频公告放宽到 6 小时窗口。
- 数据模型(单独表,不进 workflow;workflow 只管频率;模型只读):
  ```json
  { "id": "src-…", "name": "PANews", "url": "https://…/rss", "kind": "rss" | "api",
    "enabled": true, "keywords": [], "weight": 3,
    "last_fetch_at": 0, "last_status": "ok" | "error", "last_error": null, "item_count": 0 }
  ```
  关键词为空全收、有值任一命中;权重 1–5 只影响排序。API 类只允许预设适配器;拒绝内网地址与带凭证的 URL。「只看这些源」是本机视图偏好,不停采集。

## 4. 需要 gateway 的字段(已发并行 session)

1. **原文链接**:现在 `MarketState.news[].ref` 是 `I3` 这种引用编号,不是事件 id,前端拿它去 `/api/info/events` 找 `source_ref` 命不中(我昨晚接的链接实际不生效)。要 news[] 每条带稳定 `event_id` 和 `url`(代码回填;旧快照用当轮 info_refs 映射),不能依赖最近 100 条事件。
2. **信息源表**:`GET/POST /api/info/sources`、`POST /api/info/sources/:id`(启停/关键词/权重)、`DELETE`、`POST /api/info/sources/:id/test`(试抓返回前 5 条);字段如 §3;默认七源种子;抓取状态写回表。
3. **采集状态**:`MarketState` 或 `/api/info/status` 给每源上次抓取时间与错误,页面顶栏「过期/失败」用它。

## 5. 落地顺序

第一刀:修原文链(gateway 给 event_id/url);第二刀:单页重排 + 「拿去问 Agent」;第三刀:来源管理 UI + 默认七源;最后:自定义源与试抓。

## 6. 拍板与落地(09-06 中午)

Jacky:结构认可;默认源**五个**(CoinDesk、Cointelegraph、Decrypt、PANews、美联储),律动与以太坊基金会博客先不加;**不允许自定义源**。
gateway(另一工作线,a1c2eca + 09438cd,契约 §9.17):五源真抓验证、每源 10 条总 25、跨源按链接/归一化标题去重;`GET /api/info/sources` 只读状态表,无增删改;红黄口径:任一源 error 黄,全部 error 或 as_of 超过 info_every_ms×2 红。
webui:`pages/intel.tsx` 重写为单页(顶栏态势+新鲜度+来源弹层+频率弹层+立即总结 → 先看什么(重点/风险事件/关注线索→筛选页)→ 新闻流(按时间|高相关;来源徽章;「相关度」徽章;模型解读两行可展开;拿去问 Agent 走 `askAgent` 预填不自动发;无 http 链接标「原文缺失」;「这轮没有新闻」与「采集失败」分开)→ 右栏主流币/情绪/异动默认收起 → 底部偏向历史/原始事件折叠,展开才拉数据)。§3 的 keywords/weight/enabled 字段随「不做自定义」一起取消。
