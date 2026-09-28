# 信号市场改版(新用户视角)· 2026-09-25

Jacky 的反馈(截图):发布页看不出上了几个产品、没法管理我的 ASP 订阅者、不知道怎么调整已上架的产品;订阅页进行中的要排前面,取消的按试用状态显示;信号页难看。要求从新用户出发重做,首次引导和日常使用都要一眼看懂。

## 原则
1. **每一栏先回答「现在是什么状态、下一步做什么」**,细节折叠。
2. **首次引导**:每栏顶部一张可关闭的引导卡(localStorage 记住已读),3 步以内,每步有「去做」按钮;完成的步骤打勾。
3. **业务语言**:不出现 review_only / evidence / 扇出 / analysis 这类内部词;模式、状态全部中文人话,英文由 i18n-en.ts 补。
4. **对外写操作**(改价格/描述、上下架)必须二次确认,确认框里写清会发生什么(改资料会触发 OKX 重新审核)。

## 信息架构

### 发布(我是卖方)
- **顶部:ASP 身份条** —— 名称 #13866 · 上架状态人话化(审核中 / 已上架 / 被拒:原因) · 在线状态 · 可领收入 + 领取按钮。
- **引导卡(新用户)**:① 注册 ASP 身份 ② 上架第一个产品 ③ 提交审核 ④ 等第一个订阅者 / 第一张订单。
- **我的产品(核心)**:卡片网格,8 个产品(策略信号 + 7 个服务)。每张卡:
  - 名称、类型(订阅 / 按次)、价格(月费或每次)、试用
  - 状态:已上架 / 审核中 / 已暂停接单 / 未上架
  - 指标:订阅类 = 活跃订阅者(其中试用中 N);按次类 = 近 7 天订单数、累计订单;两类都有「最近一次交付 X 分钟前 · 成功率」
  - 操作:预览交付、暂停/恢复接单、调整(价格/描述 → 预检 → 确认提交)、展开看订阅者 / 订单
- **展开区**:该产品的订阅者列表(买方、试用/付费、开始/到期、已推送条数)或订单列表(买方、需求原文、状态、交付时间、交付摘要)。
- **策略信号的发布器设置与投递账本**放进「策略信号」卡的展开区(高级),不再占首屏。

### 订阅(我是买方)
- 排序:进行中(ACTIVE 付费)→ 试用中(显示剩余时长)→ 等待服务方接单 → 已取消但试用未到期(「已取消续费 · 试用至 X」)→ 已结束(折叠)。
- 引导卡:① 去「市场」挑服务 ② 免费试用 ③ 在「信号」看收到的内容。

### 信号(收到的内容)
- 按订阅分组的时间线,每条一行:时间 · 来源(服务名)· 类型(交易信号 / 情报 / 告警 / 报告)· 标的与方向 · 一句摘要;点开看原文与关键价位。
- 状态标签去重合并成一个(如「只记录,不下单」),「待办」区只在有待处理时出现。
- 空状态说明「订阅后收到的内容会出现在这里」。

## 后端接口(契约)

### GET /api/asp-services/products
```ts
{
  asp: { agent_id: string|null; name: string|null; approval: { code: number|null; label: string; remark: string|null }; online: boolean|null; claimable_usdt: string|null },
  checklist: { key: 'asp'|'listed'|'review'|'first_customer'; label: string; done: boolean; hint: string }[],
  products: {
    key: string;                 // 'strategy_signal' | ListingKey
    name: string; kind: 'subscription'|'one_time';
    price: string; price_unit: 'month'|'call'; trial_hours: number|null;
    description: string;         // 线上描述(service-list 缓存)或 catalog
    service_id: string|null; listing_id: string|null;   // listing_id = service-list 里的数字 id(改资料用)
    status: 'listed'|'in_review'|'paused'|'not_listed';
    paused: boolean;
    stats: { active_subscribers: number; trial_subscribers: number; orders_7d: number; orders_total: number;
             deliveries_ok: number; deliveries_failed: number; last_delivery_at: number|null };
  }[],
  as_of: number
}
```
数据来源:service-list(缓存 5 分钟)、my-subscriptions --role provider、okx_market_provider_task / okx_market_service_push(_job) / okx_market_delivery_out(_job) / okx_market_service_result、asp_services.config。

### GET /api/asp-services/products/:key/customers
订阅类:`{ items: { job_id, buyer_agent_id, status_label, trial: boolean, started_at, ends_at, pushes: number }[] }`
按次类:`{ items: { job_id, buyer_agent_id, request: string, state_label, created_at, delivered_at, summary }[] }`

### POST /api/asp-services/products/:key/pause   `{ paused: boolean }`
暂停 = 该服务的 decide 一律拒单(理由「服务方暂停接单」),订阅扇出跳过;已接的单照常交付。存 kv `asp_services.paused`。

### POST /api/asp-services/products/:key/draft   `{ price?: string; description?: [string,string,string] }`
返回 `{ service_payload, validate: { pass, findings[] }, warns: string[] }`(本地 checkListing + `onchainos agent validate-listing`),不写链。

### POST /api/asp-services/products/:key/apply   `{ confirm: true, service_payload }`
执行 `onchainos agent update --agent-id <asp> --service '[payload]'`,返回 txHash;提示「改资料会触发 OKX 重新审核」。写操作,前端必须二次确认。

### GET /api/market/subscriptions(改)
每条加 `display: { group: 'active'|'trial'|'pending'|'cancelled_trial'|'ended'; label: string; until: number|null }`,按 group 顺序、组内按开始时间倒序返回。
