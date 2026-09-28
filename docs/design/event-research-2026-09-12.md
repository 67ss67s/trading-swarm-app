# 事件研究闭环（P5，2026-09-12）

需求：`strategy-research-v3-and-event-research-2026-09-12.md` §3。实现沿用 MarketEvent 生命周期与 impact，新增确定性采集和持久化研究 harness。没有接入 Intent、授权或交易执行通道。

## 来源和代理

| 来源 | 用途 | 失败行为 |
|---|---|---|
| https://nfs.faireconomy.media/ff_calendar_thisweek.json | USD 周历，预期/上次/重要性，识别 FOMC/CPI/PPI/NFP/PCE/GDP/初请/零售 | 解析/429失败记告警，保留其它来源 |
| https://nfs.faireconomy.media/ff_calendar_nextweek.json | 预留下一周公开周历 | 本次实抓404，明确告警，不冒充有覆盖 |
| https://www.bls.gov/schedule/news_release/bls.ics | BLS官方发布日程，支持TZID美东/DST和UTC | 本次403；无数据时不算确认来源 |
| https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm | FOMC会议最后一天14:00美东，正确解析年份与夏冬令时 | 页面结构变化/无匹配记告警 |
| https://api.bls.gov/publicAPI/v2/timeseries/data/ | CPI CUUR0000SA0、PPI WPUFD4、NFP CES0000000001；环比另抓季调 CUSR0000SA0/WPSFD4 | 状态不成功、缺当前月份、非法数值不填actual |
| Fed `newsevents/pressreleases/monetaryYYYYMMDDa.htm` | 当日声明目标利率区间上限 | 无声明或目标区间不可解析，重试后失败 |

BLS接口用无需key的单序列 GET（[官方v2签名](https://www.bls.gov/developers/api_signature_v2.htm)），没有注册凭证进入TS。所有公共抓取使用无shell的 curl 子进程，继承 HTTP(S)_PROXY，并补齐 NO_PROXY/no_proxy 的 localhost、127.0.0.1、::1；不自动跟随重定向。部署须有curl。RSS五源也复用该传输；未改变信息员来源列表。

日历每周刷新；T−24h后重新核对，失败重试尝试受6小时节流。结果以UTC存，前端本地显示。同subkind同周核对时刻，m/m与y/y分别保留metric及预期；官方时间优先但不覆盖指标口径，保留所有 observations；只接受独立源相同时间的 confirmed。预测源失败只剩官方通用日程时，保留已有metric、预期、actual与简报；forecast_verified_at标出预测值沿用时间，官方改期若与缓存来源冲突仍告警。静态9条只是部分兜底，不能保证完整未来周历。源失败会在日志、API和前端告警；tick外层捕获异常。

## 研究 harness 与预算

`research_tasks` 持久化计划、阶段、次数和产物；`research_excerpts` 保存限长原文；`research_daily_usage` 以UTC日保存预留计数。migration编号0020，不修改既有0016重复编号。

1. plan：复用cheapBrain文本通道一次，只能从服务端列出的URL选择最多3个。官方发布任务强制抓齐预设官方序列，避免模型漏选季调序列。
2. fetch：服务端再校验白名单与目录成员，最多6次（包括重试/失败），每页最多200KiB。重定向不跟随。预算先落库再发请求，崩溃时宁可多记一次，不少记。
3. extract：cheap通道第二次生成带excerpt引用的结构化结论。HTML脚本从模型正文移除，全部原文仍是不可信数据；模型没有WebSearch/WebFetch工具。
4. verify：拒绝不存在的refs和空结论；模型文字仅reported。BLS/Fed的确定性数字解析才confirmed；每个发布必须对应本次月份，不把上次API结果当本次actual。
5. brief：代码拼接有引用的结论，不调用第三次模型。官方actual在提炼前回填，并与actual_refs原子保存，因此模型失败不会抹掉已核实官方数值或留下无引用数值。

硬上限每任务2模型/6fetch；每天20模型/100fetch，workflow可降低。日历刷新和信息员既有采集有各自调度，不消耗ResearchTask预算。最多一次任务失败重试（60秒后）；调用硬上限优先，模型调用失败后的唯一任务重试使用固定来源计划或明确标注的代码原文摘录，避免第三次模型调用。发布数据延迟会重新抓源，不复用旧月份HTTP成功缓存。预算不足排队到下个UTC日。失败和取消不退已发生或预留调用。

同进程同任务合并并发Promise；每次await后重新读取消状态，取消后不写回简报/actual。重启时running任务可从持久化阶段续跑，不会清空已计次数。没有跨gateway多写者的分布式工作队列，当前部署假设单gateway调度器。

白名单：bls.gov、federalreserve.gov、bea.gov、treasury.gov、binance.com（仅support/announcement路径）、coindesk.com、cointelegraph.com、theblock.co、faireconomy.media；允许它们的子域，精确校验边界。仅HTTPS/默认端口，拒绝URL凭证。模型不能扩展目录或拼任意参数；topic研究当前是有限公开源简报，不能承诺对任意主题做全网搜索。

## 自动任务与统计口径

- T−24h建 event_prep；T+2min建event_release。auto_key=(kind,event_id)数据库唯一，不因tick/重启重复建；执行前重新检查最新expected_at并更新官方URL；自动任务记录event_expected_at，改期再次提前也会更新due_at，不按旧时间花预算。过期24h或dismiss事件不新建任务；暂停不跑研究。
- 预研输入含日历预期/上次/来源，以及已有信息员majors快照；缺失明确未知。该快照不是利率期货隐含概率，未接概率定价专源。
- CPI/PPI非季调原序列可用于同比或指数水平；m/m另取季调序列。NFP是总就业千人序列的月差。Fed是目标区间上限百分数。surprise只在口径可比且预期可解析时=actual−consensus；否则null。
- PCE/GDP/初请/零售覆盖日历及来源研究，尚无这些发布的专用actual解析器；event_release明确以unsupported_release_parser失败，不能把通用摘要标成发布任务完成。
- impact回填后stats返回surprise→move_4h配对样本和metric，不自行合并不同口径。`eventResearchSignalInput()`只暴露给event_driven的只读输入，不生成信号方向或Intent。

## 证据和前端

完成的brief同时进入事件briefs与InformationEvent(source='research',refs)。下一轮信息员会拿这些已登记研究产物做摘要，通过已有新闻证据路径提供source='research'和任务/摘录引用；研究不会被再分类成一条新的新闻事件。任务详情可查看原文摘录，纯文本渲染，模型文字不能变成HTML或命令。

事件页包含昨天/今天/明天/本周日历带、预期/上次/实际/surprise/研究状态，保留既有详情和回填。事件级与自由主题指派都由API排队；任务展示计划/抓取/结论/花费及取消。复用/api/events的market_event和research_task，移除30秒轮询，重连补拉。

P3拥有context.ts与判断页。P5没有直接改其映射：现有事件证据仍显示“事件区…”来源；独立研究新闻证据显示research。若要在事件那一行也增加结构化refs和专用点击入口，由P3合并这两个字段；原始信息事件和brief的refs已保留，不阻断研究溯源。

## 验证与运行边界

测试覆盖代理回环/限长、日历DST/多源冲突/降级、任务幂等/预算/重试/取消/并发、BLS发布月份与统计口径、API输入和真实SSE广播。实抓样例与全量测试结果见 `.codex-reports/event-research.md`。未启动、重启或部署任何服务，未发真实订单；上线与重启仍由主线负责。合并时注意runtime事件与信息员段、workflow研究键、SSE名称数组、0020迁移及§9.33追加位置。

补充实抓：Fed 2026-07-29声明的带连字符分数区间已成功解析上限3.75%；BLS季调CPI CUSR0000SA0返回REQUEST_SUCCEEDED、2026-M08指数334.131。该指数不是当月涨幅。WPSFD4本机此次请求超时，故不能声称PPI季调序列完成了在线可用性验收；单测覆盖其数据形状与计算。

## P5b 补正：事件唤醒与简报来源

- `evidence.events` 可包含普通 TriggerKind 或 `EVENT_SUBKINDS` 列出的事件 subkind。普通触发保持旧交集语义；事件 subkind 是显式订阅，为该策略增加 `event` 入口并按结构化 `event_subkind` 匹配，不要求改写原 trigger.kinds。最小周期继续生效。`vol_spike` 两种语义并存，由 hit.kind 区分。空 evidence 沿用原触发集合；显式泛型 event 且无 subkind 限制时可接收全部事件。
- 事件触发携带 `event_id/event_subkind/source_ref/research_task_id`，冻结在判断的 `trigger.hits` 并写入触发证据。排队后按 liveFor 复核；被撤销、资产不符、窗口外的旧 event hit 被移除。只有事件触发且事实失效时，不能回退成全策略唤醒。
- 简报来源以 `source=research + task_id` 为准，判断里呈现 task ID、任务详情入口、摘录 refs。旧 brief 历史保留并明确标注非 research，不作为一手简报进入模型。研究完成不代表新策略族/执行器或自动交易已实现；本次只交付事件证据与唤醒接线。
- 静态表逐条双官方发布物核对见 `.codex-reports/calendar-verification-0912.json`；BLS curl 403 的事实与浏览工具人工核对明确分开。
