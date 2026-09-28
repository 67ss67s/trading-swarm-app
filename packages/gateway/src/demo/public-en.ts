// 公网英文评审版(TG_PUBLIC_DEMO=1 且 TG_PUBLIC_LANG=en)的出口英文覆盖:只改响应序列化,不写库、不改业务语义。
// public-view.ts 的 publicView 在遍历响应时调用这里:
//   1. 对象级(按形状认,不按路由):bot profile / agent 名册按 role 强制覆盖(库里的 profile 用户可编辑,只在出口换);
//      /api/agents/:role 的 agent_md 换成 agents/en/<role>.md;研究策略按 id 查 TG_PUBLIC_STRATEGY_EN 覆盖 name/description。
//   2. 字符串级:先查精确表(常量标签),再试整句模板(交接、简报、扫描说明、模型总结失败…),
//      最后按短语拼译 —— 拼译结果还带中文就放弃、原样返回,不产出中英夹杂的半句。
// 外部内容(PANews 新闻原文、OKX.AI 第三方 agent 名字与简介、模型现写的中文历史记录)不在这里翻。
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_REGISTRY, CHAT_TOOL_CATALOG } from './agent-registry.js';
import { BoundedMap } from './bounded-map.js';
import { BOT_ROLES, type BotRole } from './bots.js';
import { CATALOG_EXACT_EN } from './public-en-catalog.js';
import { RESEARCH_EXACT_EN } from './public-en-research.js';
import { TEMPLATE_EN } from './public-en-templates.js';
import { AGENT_EN, BOT_EN, REASON_EN, TOOL_EN } from './public-en-tables.js';
import { REASON_LABELS } from './execution-policy.js';

export const publicEnglish = (): boolean => process.env['TG_PUBLIC_DEMO'] === '1' && process.env['TG_PUBLIC_LANG'] === 'en';

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
export const hasCjk = (s: string): boolean => CJK.test(s);

// ---------------------------------------------------------------- 精确表(常量标签)

const HORIZON_EN: Record<string, string> = { '短线(12h)': 'Short-term (12h)', '中线(3d)': 'Mid-term (3d)', '周线': 'Weekly' };

/** 源常量的中文原文 → 英文。键就是源码里的原文;测试逐张核对源表(FAMILY_LABEL、STATUS_LABEL、asp 标签…)都被覆盖。 */
export const EXACT_EN: Record<string, string> = {
  // 自托管实例英文层(TG_PUBLIC_LANG=en):执行通道名与说明、模型连接默认名、推荐告警
  '纸面模拟(本地撮合)': 'Paper (local simulator)',
  'Binance 模拟盘(tgate-demo-exec)': 'Binance demo (tgate-demo-exec)',
  'Binance 模拟盘(官方 binance-cli)': 'Binance demo (official binance-cli)',
  '币安官方 MCP(agent CLI 驱动)': 'Binance official MCP (via agent CLI)',
  '币安 MCP 直连(网关自己调)': 'Binance MCP direct (called by the gateway)',
  'OKX(官方 okx CLI)': 'OKX (official okx CLI)',
  '不碰交易所,余额与持仓存在本地库里;换后端不会带走纸面持仓。': 'Never touches an exchange. Balance and positions live in the local database; switching backends does not carry paper positions over.',
  '走官方 okx CLI(@okx_ai/okx-trade-cli)本地签名,密钥只在 ~/.okx/config.toml,网关只传 --profile。开仓时止损/止盈作为附带单与开仓一次提交,行情走 OKX 公共 REST。': 'Orders go through the official okx CLI (@okx_ai/okx-trade-cli), signed locally. Keys stay in ~/.okx/config.toml; the gateway only passes --profile. Stop-loss and take-profit are attached to the entry and sent in one request. Market data comes from OKX public REST.',
  '雷达三档还没跑过,短/中/长线只按全市场扫描与日线状态推荐': 'Radar tiers have not run yet; short, mid and long picks rely on the market scan and daily regime only',
  // 入场方式检查 / 发送前复查的固定句(entry-policy.ts、runtime.ts)
  '按24h成交量流动性上限钳制': 'Capped by the 24h volume liquidity limit',
  '数量低于交易所最小下单量': 'Size is below the exchange minimum order size',
  '低于交易所最小名义，拒单': 'Below the exchange minimum notional, rejected',
  '流动性上限或 sizing 数据不可用，拒单': 'Liquidity cap or sizing data unavailable, rejected',
  '候选没有可验证的止损(缺失或在错误一侧),不能进入止损预算': 'The candidate has no verifiable stop (missing or on the wrong side), so it cannot enter the stop budget',
  '接近上限(> 80%)': 'Close to the limit (> 80%)',
  '权益 ≤ 0 或缺失': 'Equity is ≤ 0 or missing',
  '提议通过代码闸,建线程': 'Proposal passed the code checks; thread created',
  'limit_only:市价开仓一律拒(该策略规则没有 entry_mode=market_ok);请给 entry="limit" + limit_price,挂单的对齐/耐心/撤单链照旧': 'limit_only: market entries are always rejected (this strategy\'s rules do not set entry_mode=market_ok); send entry="limit" with a limit_price, and order alignment, patience and cancellation work as before',
  'limit_only:该策略规则写了 entry_mode=market_ok,市价放行': 'limit_only: this strategy\'s rules set entry_mode=market_ok, so a market entry is allowed',
  'limit_only:限价入场': 'limit_only: limit entry',
  '入场方式不限制(free)': 'Entry type not restricted (free)',
  '非开仓动作': 'Not an opening action',
  '没有入场方式证据,不拦': 'No entry-type evidence, not blocked',
  '限价入场': 'Limit entry',
  '限价入场(挂在现价不利侧等回踩)': 'Limit entry (waiting on the far side of the price for a pullback)',
  '限价入场(身份未证明,距离闸不拦)': 'Limit entry (type not proven, distance check does not block)',
  '方向成立但回踩未确认:只许挂等待型限价,市价拒': 'Direction confirmed but the pullback is not: only a waiting limit order is allowed, market rejected',
  '入场时机判据已经不成立(不是「还没到」而是「过了/坏了」),不许开仓': 'The entry timing condition no longer holds (not "not yet" but "passed or broken"), so no entry',
  '回踩已确认且离突破位不远,市价可用': 'Pullback confirmed and close to the breakout level; market entry is fine',
  '清单没给突破距离,按限价等回踩更稳': 'The checklist gave no breakout distance; a limit order waiting for the pullback is safer',
  '发送前行情过期': 'Market data went stale before sending',
  '发送前硬闸数据不可用': 'Data for the pre-send checks was unavailable',
  '发送前 IR 几何已失效,不改价': 'Before sending, the strategy\'s stop and target levels were no longer valid; prices were not changed',
  '发送前 IR min_rr 不满足,不改价': 'Before sending, the strategy\'s minimum R:R was no longer met; prices were not changed',
  '策略限价挂单已过期,请等待下一次信号': 'The strategy\'s limit order expired; wait for the next signal',
  '发送前发现紧急停止': 'Emergency stop found before sending',
  '发送前策略运行已暂停/停止或通道/杠杆上限改变': 'Before sending, the strategy run was paused or stopped, or its channel or leverage cap changed',
  // funnel.ts(GET /api/funnel)条件名、阶梯/质量变体标签;含 09-27 前的「F + …」旧标签,旧报告回放也要英文
  'ATR% ≥ 分周期门槛': 'ATR% ≥ per-timeframe floor',
  '1h/4h EMA20-vs-EMA50 同向': '1h/4h EMA20-vs-EMA50 aligned',
  '距突破位 ≤ chase_atr_max ATR': 'Distance to breakout ≤ chase_atr_max ATR',
  '已收破突破位(窗口内)': 'Closed beyond the breakout level (within window)',
  '量比 ≥ retest_vol_min': 'Volume ratio ≥ retest_vol_min',
  '资金费率绝对值 ≤ 上限': '|Funding rate| ≤ cap',
  '日线状态不反对该方向': 'Daily regime does not oppose the direction',
  '现行规则(scanChecklist 原样)': 'Current rules (scanChecklist as-is)',
  '现行 + ATR 门槛 ×0.5': 'Current + ATR floor ×0.5',
  '现行 + 距突破位 ≤ 2.0 ATR': 'Current + distance to breakout ≤ 2.0 ATR',
  '现行 + 量比 ≥ 0.8': 'Current + volume ratio ≥ 0.8',
  '现行 + 量比当根或突破那根达标即可': 'Current + volume ratio met on the current bar or the breakout bar',
  '现行 + 只看 1h(4h 强烈反向才否决)': 'Current + 1h only (4h vetoes only when strongly opposed)',
  '现行 + 回踩窗口放宽到 12 根': 'Current + retest window widened to 12 bars',
  '现行 + 窗口 12 根 + 量比查突破那根': 'Current + 12-bar window + volume checked on the breakout bar',
  '现行 + 窗口 12 + 量比突破根 + ATR ×0.5': 'Current + 12-bar window + breakout-bar volume + ATR ×0.5',
  '现行 + 窗口 12 + 量比突破根 + ATR ×0.5 + 只看 1h': 'Current + 12-bar window + breakout-bar volume + ATR ×0.5 + 1h only',
  '全部放宽(再加 chase 2.0 / range 量比 1.0)': 'Everything relaxed (plus chase 2.0 / range volume ratio 1.0)',
  '底座:现行 + 窗口 12 + 量比查突破那根': 'Base: current + 12-bar window + volume checked on the breakout bar',
  '底座 + 突破那根量比 ≥ 1.5': 'Base + breakout-bar volume ratio ≥ 1.5',
  '底座 + 突破那根量比 ≥ 2.0': 'Base + breakout-bar volume ratio ≥ 2.0',
  '底座 + 只在距突破位 ≤ 0.8 ATR 处入场': 'Base + enter only within 0.8 ATR of the breakout level',
  '底座 + 只在距突破位 ≤ 0.5 ATR 处入场': 'Base + enter only within 0.5 ATR of the breakout level',
  '底座 + 突破必须在 4 根内(更新鲜)': 'Base + breakout within the last 4 bars (fresher)',
  '底座 + 只在日线 bull/bear 里做': 'Base + trade only in daily bull/bear regimes',
  '底座 + ATR% 门槛 ×1.5(只做活跃的)': 'Base + ATR% floor ×1.5 (active markets only)',
  '底座,第一止盈 1.0R': 'Base, first target 1.0R',
  '底座,第一止盈 2.0R': 'Base, first target 2.0R',
  '底座,第一止盈 3.0R': 'Base, first target 3.0R',
  '底座,止损 1.2 ATR': 'Base, stop 1.2 ATR',
  '底座,止损 0.5 ATR': 'Base, stop 0.5 ATR',
  '底座,最多持有 96 根': 'Base, max holding 96 bars',
  '底座 + 量比 1.5 + 窗口 4 + 只做趋势日线': 'Base + volume ratio 1.5 + 4-bar window + trending daily regime only',
  '对照:无条件,只跟 1h 方向(每 4 根一次)': 'Control: no conditions, follow the 1h direction only (once every 4 bars)',
  '窗口内没有可用 K 线': 'No usable candles in the window',
  '币安': 'Binance',
  'OKX 上没有': 'Not listed on OKX',
  '币安上没有': 'Not listed on Binance',
  'F:突破位改用前 20 根(不含当根)': 'F: breakout level uses the prior 20 bars (excluding the current bar)',
  'F + ATR 门槛 ×0.5': 'F + ATR floor ×0.5',
  'F + 距突破位 ≤ 2.0 ATR': 'F + distance to breakout ≤ 2.0 ATR',
  'F + 量比 ≥ 0.8': 'F + volume ratio ≥ 0.8',
  'F + 量比只在突破那根查': 'F + volume checked only on the breakout bar',
  'F + 只看 1h(4h 强烈反向才否决)': 'F + 1h only (4h vetoes only when strongly opposed)',
  'F + 回踩窗口放宽到 12 根': 'F + retest window widened to 12 bars',
  'F + 窗口 12 根 + 量比查突破那根': 'F + 12-bar window + volume checked on the breakout bar',
  'F + 窗口 12 + 量比突破根 + ATR ×0.5': 'F + 12-bar window + breakout-bar volume + ATR ×0.5',
  'F + 窗口 12 + 量比突破根 + ATR ×0.5 + 只看 1h': 'F + 12-bar window + breakout-bar volume + ATR ×0.5 + 1h only',
  '底座:F + 窗口 12 + 量比查突破那根': 'Base: F + 12-bar window + volume checked on the breakout bar',
  // strategies.ts FAMILY_LABEL / STATUS_LABEL
  '趋势延续': 'Trend continuation',
  '多周期': 'Multi-timeframe',
  '波动结构': 'Volatility structure',
  '衍生品结构': 'Derivatives structure',
  '均值回归': 'Mean reversion',
  '相对价值（离线）': 'Relative value (offline)',
  '草稿': 'Draft',
  '回测中': 'Backtesting',
  '影子': 'Shadow',
  '纸面': 'Paper',
  '限额实盘': 'Capped live',
  '已退役': 'Retired',
  // types.ts TIER_LABEL
  '短线': 'Short-term',
  '中线': 'Mid-term',
  '长线': 'Long-term',
  // screener.ts HORIZON_LABEL
  ...HORIZON_EN,
  // 内置策略名(strategies.ts 目录 + 中/长线突破回踩变体)
  '突破-回踩': 'Breakout-Retest',
  '多周期对齐': 'Multi-timeframe alignment',
  '波动压缩→扩张': 'Volatility squeeze → expansion',
  '资金费率/OI 极值': 'Funding rate / OI extremes',
  '区间均值回归': 'Range mean reversion',
  '中线突破回踩': 'Mid-term Breakout-Retest',
  '长线突破回踩': 'Long-term Breakout-Retest',
  // asp-agent/services STATUS_LABELS / TASK_STATE_LABELS(+ 列表里的兜底标签)
  '待接单': 'Awaiting acceptance',
  '付费中': 'Paid, active',
  '已拒收': 'Rejected',
  '争议中': 'In dispute',
  '已完成': 'Completed',
  '已结束': 'Ended',
  '已到期': 'Expired',
  '失败': 'Failed',
  '已取消': 'Cancelled',
  '试用中': 'On trial',
  '状态未知': 'Unknown status',
  '新订单': 'New order',
  '未接单(服务未启用)': 'Not accepted (service not enabled)',
  '拒单中': 'Declining',
  '已拒单': 'Declined',
  '拒单结果待确认': 'Decline result pending confirmation',
  '接单中': 'Accepting',
  '已接单,生成中': 'Accepted, generating',
  '接单结果待确认': 'Accept result pending confirmation',
  '交付中': 'Delivering',
  '已交付': 'Delivered',
  '交付失败,待重试': 'Delivery failed, will retry',
  '交付结果待确认': 'Delivery result pending confirmation',
  '未交付(需求无法处理)': 'Not delivered (request cannot be handled)',
  '已关闭': 'Closed',
  '等待服务方接单': 'Waiting for the provider to accept',
  '进行中': 'Active',
  '争议处理中': 'Dispute in progress',
  // info.ts 信息源
  '美联储新闻稿': 'Federal Reserve press releases',
  // evolution.ts ROLE_SPECS label
  '判断': 'Judgment',
  '雷达': 'Radar',
  '策略实验台': 'Strategy Lab',
  '组合': 'Portfolio',
  '风控': 'Risk',
  '执行': 'Execution',
  '复盘': 'Review',
  '指挥': 'Command',
  '信号市场': 'Signal Market',
  // graph.ts GUARDS + 分层闸 / 事件闸
  '紧急停止': 'Emergency stop',
  '紧急停止中不允许开仓': 'No new positions during an emergency stop',
  '暂停': 'Paused',
  '暂停中不开新仓': 'No new positions while paused',
  '证据新鲜度': 'Evidence freshness',
  '开仓判断不能引用 STALE 证据': 'An open decision may not cite STALE evidence',
  '无持仓才能开仓': 'Open only when flat',
  '本币已有持仓则不开': 'No new position if this symbol already has one',
  '每日开仓上限': 'Daily open cap',
  '当日开仓次数上限': 'Maximum number of opens per day',
  '止损在正确一侧': 'Stop on the correct side',
  '做多止损低于入场、做空高于入场': 'Long stop below entry, short stop above entry',
  '止损距离': 'Stop distance',
  '止损距离在 min–max % 之间': 'Stop distance within min–max %',
  '止盈在正确一侧': 'Take-profit on the correct side',
  '止盈方向与持仓方向一致': 'Take-profit direction matches the position',
  '信心下限': 'Confidence floor',
  '开仓信心 ≥ 0.40': 'Open confidence ≥ 0.40',
  '线程/日内限制': 'Thread / intraday limits',
  '同币已有线程 / 线程数上限 / 日开仓上限 / 日亏停': 'Existing thread on the symbol / thread cap / daily open cap / daily loss stop',
  '没有状态不明的订单': 'No orders in unknown state',
  '有 unknown 意图时不开新仓': 'No new positions while an intent is unknown',
  '提交前重闸': 'Pre-submit re-gate',
  '下单前用最新账户/线程集重查一遍': 'Re-check against the latest account and thread set before ordering',
  '演示版不加仓': 'No adding in the demo',
  'ADD 只记录不执行': 'ADD is recorded, not executed',
  '线程仍开放': 'Thread still open',
  '判断期间线程已结束则整条复查作废': 'If the thread closed during the judgment, the review is void',
  '入场方式': 'Entry style',
  '策略共识': 'Strategy consensus',
  '事件封锁': 'Event blackout',
  '短线每日开仓上限': 'Short-term daily open cap',
  '中线每日开仓上限': 'Mid-term daily open cap',
  '长线每日开仓上限': 'Long-term daily open cap',
  '短线容量上限': 'Short-term capacity cap',
  '中线容量上限': 'Mid-term capacity cap',
  '长线容量上限': 'Long-term capacity cap',
  '短线入场方式': 'Short-term entry style',
  '中线入场方式': 'Mid-term entry style',
  '长线入场方式': 'Long-term entry style',
  // 名册 presence / 杂项
  '不变量全过': 'All invariants pass',
  '还没有平仓可复盘': 'No closed trades to review yet',
  '等第一次账户快照': 'Waiting for the first account snapshot',
  '已暂停': 'Paused',
  '已暂停:到点不筛': 'Paused: scheduled screens skipped',
  '收件箱清空': 'Inbox clear',
  '收件箱清空;今日简报已出': "Inbox clear; today's brief is out",
  '回答对话': 'Answering chat',
  '机械期望实验在跑': 'Mechanical-expectancy experiment running',
  '批量复盘提炼教训': 'Batch review: distilling lessons',
  '接收入站投递': 'Receiving inbound deliveries',
  '发布器已启用': 'Publisher enabled',
  '紧急停止:只允许 NO_TRADE': 'Emergency stop: NO_TRADE only',
  '紧急停止:不接新单': 'Emergency stop: no new orders',
  '紧急停止生效中': 'Emergency stop in effect',
  '趋势周期不同向': 'Trend timeframes disagree',
  '本次未计算机械期望': 'Mechanical expectancy not computed this time',
  '没有新的合格平仓': 'No new eligible closed trades',
  '没有优势': 'No edge',
  '有苗头,记为观察': 'Early signs; recorded as a watch',
  '亚洲盘中': 'Asia session',
  '欧洲盘中': 'Europe session',
  '美洲盘中': 'US session',
  // triggers.ts sessionInfo 的时段描述(评审版周六冒烟漏网:周末分支)
  '周末,传统市场休市,流动性偏低': 'Weekend: traditional markets closed, liquidity is thin',
  '亚洲/欧美都收市的清淡时段': 'Quiet hours: Asian, European and US markets all closed',
  '美股盘中': 'US equities in session',
  '伦敦盘中': 'London session',
  // gates.ts / holding-policy.ts 闸门名与固定理由
  '持仓计划': 'Holding plan',
  '策略ATR尺度': 'Strategy ATR scale',
  '可选ATR尺度': 'ATR scale choices',
  '净盈亏比': 'Net reward/risk',
  '结构失效价': 'Structural invalidation',
  '系统紧急停止中,不允许开仓': 'System emergency stop: no new positions',
  '未触发': 'Not triggered',
  '已暂停,不开新仓': 'Paused: no new positions',
  '运行中': 'Running',
  '已有持仓': 'Position already open',
  '当前无持仓': 'No open position',
  '现货,无止损(可选)': 'Spot, no stop (optional)',
  '通过': 'Passed',
  '演示版只记录 ADD 建议,不执行': 'The demo only records ADD suggestions; not executed',
  '有一笔订单状态不明,先核对再开新仓': 'An order is in unknown state; reconcile before opening',
  '失效价须位于入场的不利一侧与硬止损之间，不从自由文本漂移': 'The invalidation price must sit between the adverse side of entry and the hard stop, not drift from free text',
  // 桩大脑(无模型时的占位输出)
  '桩大脑:不交易': 'Stub brain: no trade',
  '测试 [E1]': 'Test [E1]',
  // 研究实验 / 矩阵研究的固定文案
  'load 失败超过 20%，覆盖率阻断，不生成 lab_stats': 'Load failures above 20%: coverage blocked, lab_stats not generated',
  '按这条策略的规则,此刻按给定的入场、止损和目标开仓是否合理': "Under this strategy's rules, is opening now with the given entry, stop and target reasonable",
  '这笔候选的整体质量': 'Overall quality of this candidate',
  '趋势、波动与盈亏比支持这笔入场': 'Trend, volatility and reward/risk support this entry',
  '状态与策略前提不符或盈亏比不足': 'Regime does not fit the strategy premise, or reward/risk is insufficient',
  '差:前提明显不成立': 'Poor: the premise clearly does not hold',
  '一般:勉强成立': 'Fair: barely holds',
  '好:前提成立': 'Good: the premise holds',
  '很好:多项证据一致': 'Very good: multiple pieces of evidence agree',
  '信息员:还没有总结': 'Info scout: no summary yet',
  // evolution.ts:进化页方格的指标说明与空日
  '已结算判断事后 R:模型 − 机械对照(簇均值,按判断日)': 'Post-hoc R of settled judgments: model minus mechanical baseline (cluster mean, by judgment day)',
  '前 8 名候选在有效期内被跟进(WATCH/PROPOSE)的比例;只有进了 watchlist 的币才可能被判断': 'Share of top-8 candidates followed up (WATCH/PROPOSE) while valid; only watchlist symbols can be judged',
  '研究/回测/改进环完成率;过门槛候选或晋升记为好': 'Completion rate of research / backtests / improvement loops; a gate-passing candidate or a promotion counts as good',
  '当天账户收益 − BTC 持有收益(剔除出入金)': "Day's account return minus BTC buy-and-hold return (transfers excluded)",
  '当天新增 high/critical 告警(fingerprint 去重),越少越好': 'New high/critical alerts that day (deduplicated by fingerprint); fewer is better',
  '1 − 交易所接口报错占比;有下单时看执行失败率': '1 minus the exchange API error share; with orders, the execution failure rate',
  '当天教训提案的采纳率(kind=lesson)': "Adoption rate of the day's lesson proposals (kind=lesson)",
  '模型调用空转比例(票池为空的扫描 / 只许 HOLD 的复查),越低越好': 'Share of idle model calls (scans with an empty pool / reviews that may only HOLD); lower is better',
  '信号收发与巡检运行成功率': 'Success rate of signal send/receive and patrol runs',
  '当天没有判断': 'No judgments that day',
  '当天没有筛选': 'No screens that day',
  '当天没有研究活动': 'No research activity that day',
  '当天没有权益记录': 'No equity records that day',
  '权益记录不足两条,算不出收益': 'Fewer than two equity records; return not computable',
  '当天没有新告警': 'No new alerts that day',
  '当天没有执行相关记录': 'No execution records that day',
  '当天没有复盘': 'No reviews that day',
  '当天没有信号收发': 'No signals sent or received that day',
  '票池配置为空,也没有扫描记录': 'Pool config is empty and there are no scan records',
  '从没跑过实验': 'No experiment has run yet',
  '共识闸当前无效:没有策略能投票(全部弃权)': 'Consensus gate currently inactive: no strategy can vote (all abstain)',
  // OKX.AI 信号市场:订阅 / 入站 / 产品审核(asp-agent)
  '平台没有返回这条订阅': 'The platform did not return this subscription',
  '投递里挑不出信号对象': 'No signal object found in the delivery',
  'symbol/instId 缺失': 'symbol/instId missing',
  '无法确定 published_at(信号时间与队列 created_at 都解析不出)': 'Cannot determine published_at (neither the signal time nor the queue created_at parses)',
  'tg · 市场情报 自测': 'tg · Market intel (self-test)',
  'tg · 微观告警 自测': 'tg · Micro alerts (self-test)',
  'tg · Trading Swarm 自测试用': 'tg · Trading Swarm (self-test)',
  '市场情报 自测': 'Market intel (self-test)',
  '微观告警 自测': 'Micro alerts (self-test)',
  'Trading Swarm 自测试用': 'Trading Swarm (self-test)',
  'trade-gate · 市场情报 自测': 'trade-gate · Market intel (self-test)',
  'trade-gate · 微观告警 自测': 'trade-gate · Micro alerts (self-test)',
  '审核中': 'Under review',
  '重新审核中(资料有改动)': 'Re-review in progress (listing changed)',
  '未提交审核': 'Not submitted for review',
  '改资料触发重新审批': 'Listing edit triggered a re-review',
  '注册 ASP 身份': 'Register the ASP identity',
  '上架第一个产品': 'List the first product',
  '提交审核': 'Submit for review',
  '等第一个订阅者 / 第一张订单': 'Wait for the first subscriber / first order',
  '先注册 ASP 身份(名称、头像、第一个服务),才能上架产品': 'Register the ASP identity first (name, avatar, first service) before listing products',
  '在产品卡上点「调整」,预检通过后提交上架': 'Click "Adjust" on a product card and submit the listing once the precheck passes',
  '上架情况暂时查不到,稍后刷新': 'Listing status unavailable right now; refresh later',
  '资料还没提交审核': 'The listing has not been submitted for review yet',
  '审核状态暂时查不到': 'Review status unavailable right now',
  '已有订阅者或订单,展开产品卡查看': 'There are subscribers or orders; expand a product card to see them',
  '上架通过后,买方订阅或下单会出现在这里': 'Once the listing is approved, buyer subscriptions and orders show up here',
  // 研究页:回测评分说明(research/analyzer.ts 的固定句)
  '窗口内没有平仓交易,无法评价': 'No closed trades in the window; cannot be scored',
  '缺持有基准,按中性计': 'No buy-and-hold baseline; scored as neutral',
  '缺样本内/外年化收益,按中性计': 'In/out-of-sample annualized returns missing; scored as neutral',
  '没有亏损交易': 'No losing trades',
  '没有盈利交易': 'No winning trades',
  '日收益不足 30 个,Sharpe 不可用': 'Fewer than 30 daily returns; Sharpe unavailable',
  '无平仓交易': 'No closed trades',
  // Pine 引擎健康检查提示(research/pine/client.ts)
  'Pine 引擎由网关托管自动拉起(packages/pine-engine,AGPL-3.0 独立进程);状态看 GET /api/research/pine/health,TG_PINE_ENGINE=0 会关掉它,崩溃连续重启失败后标记 down,需重启网关':
    'The Pine engine is started and supervised by the gateway (packages/pine-engine, a separate AGPL-3.0 process); check status at GET /api/research/pine/health. TG_PINE_ENGINE=0 turns it off; after repeated crash-restart failures it is marked down and the gateway must be restarted',
  // 公网英文模式上线前模型写成中文的判断标题(历史记录,只在出口译)
  'BNB 周期信号互相矛盾，无合格突破回踩形态': 'BNB timeframe signals conflict; no qualifying breakout-retest setup',
  'BNB 周期互相矛盾,无合格突破回踩形态,观望': 'BNB timeframes conflict; no qualifying breakout-retest setup; standing aside',
  '1h EMA20<EMA50 偏空，4h EMA20>EMA50 偏多，周期方向不一致，扫描判定不取突破位 [E9]': '1h EMA20<EMA50 bearish, 4h EMA20>EMA50 bullish: timeframes disagree, so the scan takes no breakout level [E9]',
  '15m 价在 EMA20 下方，量比 0.50 低于 1.00 门槛，回踩确认=no [E9]': '15m price is below EMA20, volume ratio 0.50 is under the 1.00 threshold, retest_confirmed=no [E9]',
  '代码扫描 watch_eligible=no，说明策略确认周期不同向、无合格追单条件 [E9]': 'The code scan says watch_eligible=no: the strategy confirmation timeframes disagree and there is no qualifying chase condition [E9]',
  'ADX14 12.9 无趋势、BB 宽 2 分位挤压 2 根，价格夹在 EMA20/EMA50 之间震荡，属 playbook 的 NO_TRADE 情形 [E9]': 'ADX14 12.9 shows no trend, BB width at the 2nd percentile with a 2-bar squeeze, price chopping between EMA20/EMA50: a NO_TRADE case under the playbook [E9]',
  'ATR% 0.16% 仅略高于 0.15% 门槛，1h ATR 0.49%，波动不足以支撑 0.3%-5% 的结构性止损空间 [E9]': 'ATR% 0.16% is only slightly above the 0.15% threshold and 1h ATR is 0.49%; volatility is too low to support a 0.3%-5% structural stop [E9]',
  '策略议会共识闸无效，能投票策略为 0，代码裁决不允许下单 [E11]': 'The strategy council consensus gate is inactive with 0 voting strategies; the code ruling does not allow an order [E11]',
  '扫描清单给出 watch_eligible=no:1h/4h 未同向,回踩确认 no,所以按规则只能 NO_TRADE 而不能 WATCH [E9]': 'The scan checklist gives watch_eligible=no: 1h/4h are not aligned and retest_confirmed=no, so the rules allow only NO_TRADE, not WATCH [E9]',
  '1h EMA20<EMA50(偏空)而 4h EMA20>EMA50(偏多),交易方向没有一致性依据,突破位无法取定 [E9]': '1h EMA20<EMA50 (bearish) while 4h EMA20>EMA50 (bullish): no consistent basis for a trade direction, so no breakout level can be set [E9]',
  '15m 量比 0.75 低于 1.00 的确认门槛,回踩确认=no,不满足市价入场条件;代码建议限价但没有可得的参考挂单区 [E9][E10]': '15m volume ratio 0.75 is under the 1.00 confirmation threshold, retest_confirmed=no, so market-entry conditions are not met; code suggests a limit order but no reference order zone is available [E9][E10]',
  '策略议会共识闸无效,所有策略弃权,0 条可投票,没有任何策略能把这个机会翻成可执行裁决 [E11]': 'The strategy council consensus gate is inactive: all strategies abstain, 0 can vote, so no strategy can turn this into an executable ruling [E11]',
  'ADX14 12.8 无趋势、BB 宽 2 分位挤压,属震荡环境,playbook 明确价格夹在 EMA20 与 EMA50 之间震荡时不做 [E9]': 'ADX14 12.8 shows no trend and BB width at the 2nd percentile is a squeeze: a ranging market, and the playbook says not to trade when price chops between EMA20 and EMA50 [E9]',
  '事件虽多但均为 reported 级背景新闻,不能单独作为开仓理由,当前也没有 2 小时内的高相关风险事件驱动方向 [E21][E22][E23]': 'There are many events, but all are reported-level background news and cannot justify an entry on their own; there is also no highly relevant risk event within 2 hours driving direction [E21][E22][E23]',
  'calendar_fallback: 部分日程仅有静态兜底，尚未核实': 'calendar_fallback: some calendar entries come from the static fallback and are not yet verified',
  // §9.56 交易页三层(2026-09-27)。strategy-run.ts 预检 blockers / warnings(带数字的在 public-en-templates.ts;含「;」的按段给,
  // 启动失败时多条 blocker 会用「;」拼成一条 error,切段后每段都要能译)
  '雷达币池依赖尚未接线': 'The radar coin pool is not available yet',
  '波动率目标仓位执行尚未接线，不能退回固定风险仓位': 'Volatility-target position sizing is not available yet, and the run will not fall back to fixed-risk sizing',
  '该策略需要钉住模型与判断账本，请配置 judge 依赖后运行': 'This strategy needs a pinned judge model and a judgment log; set up the judge before running it',
  '判断要素需要的决策模型连接未绑定或不可用(去「模型连接」绑定 decision 角色)': 'The decision model used by the strategy\'s judge is not connected or not available (bind the decision role under Model connections)',
  '换回原连接,或重新研究后再运行': 'Switch back to the original connection, or redo the research before running',
  '这条策略还没有可执行规则,请先在研究台生成并保存一个规则版本': 'This strategy has no executable rules yet; generate and save a rule version in the research lab first',
  '规则暂时无法执行,请在研究台修正编译提示后保存新版本': 'The rules cannot run yet; fix the compiler notes in the research lab and save a new version',
  '这条策略已归档,请先恢复策略再运行': 'This strategy is archived; restore it before running',
  '这条策略要做空,请把市场选永续': 'This strategy goes short; choose the perpetual market',
  '这条双向策略还没有做空触发条件,请在研究台补充做空条件或改为只做多': 'This two-way strategy has no short entry condition yet; add one in the research lab or make it long-only',
  '这条策略要求杠杆,请把市场选永续,或在研究台改为无杠杆': 'This strategy uses leverage; choose the perpetual market, or remove leverage in the research lab',
  '这条入场规则还不能执行,请在研究台改为收盘确认、下一根入场': 'This entry rule cannot run yet; in the research lab, change it to confirm on the close and enter on the next bar',
  '止盈规则没有说明各档比例,请在研究台用 order.take_profits 配置目标和比例': 'The take-profit rules do not say how much to close at each target; set targets and sizes with order.take_profits in the research lab',
  '这条策略需要更多高周期历史,请缩短高周期指标回看长度后重试': 'This strategy needs more higher-timeframe history; shorten the lookback of the higher-timeframe indicators and try again',
  '只挂最近第一档,按研究核归一后的 size_pct 部分止盈;其他档位不挂并记录在线程上,余仓由止损/信号离场/时间止损管理': 'Only the nearest target is placed, as a partial take-profit sized by the normalized size_pct from research; the other targets are not placed but are recorded on the trade, and the rest of the position is managed by the stop, the signal exit or the time stop',
  '当前执行通道不支持按数量挂止盈,请切换纸面或 OKX,或把策略改为单目标': 'The current execution venue cannot place take-profits by quantity; switch to paper or OKX, or change the strategy to a single target',
  '每根收盘用运行币池等权构造市场因子并筛选;币池变化会影响排名,历史不足时跳过': 'At each close, an equal-weight market factor is built from the run\'s coin pool and used to screen; changes to the pool affect the ranking, and coins without enough history are skipped',
  '未成交 replace 缺撤单接线': 'Replacing an unfilled order needs order cancelling, which is not available',
  'roll 无费结转尚未实现': 'Rolling a position over without fees is not supported yet',
  'confirm 模式反手缺整项审批接线(auto/agent 已支持)': 'Reversing a position in confirm mode is not supported yet (auto/agent support it)',
  '这条策略的同币新信号会加仓,运行器还没接加仓执行链': 'In this strategy a new signal on the same coin adds to the position, and the runner cannot add to positions yet',
  '先改 IR 的 on_new_signal 或等接线后再运行': 'Change on_new_signal in the strategy rules first, or wait until adding is supported',
  '这条策略靠追踪/保本/结构移损管仓,运行器的移损还没接通(缺 moveStop 或首档止盈成交状态)': 'This strategy manages positions by moving the stop (trailing / breakeven / structure), and the runner cannot move stops yet (moveStop or the first-target fill status is missing)',
  '接通前不能运行': 'It cannot run until that is available',
  '这条策略的同币新信号会加仓,运行器还没接加仓执行链;先改 IR 的 on_new_signal 或等接线后再运行': 'In this strategy a new signal on the same coin adds to the position, and the runner cannot add to positions yet; change on_new_signal in the strategy rules first, or wait until adding is supported',
  '这条策略靠追踪/保本/结构移损管仓,运行器的移损还没接通(缺 moveStop 或首档止盈成交状态);接通前不能运行': 'This strategy manages positions by moving the stop (trailing / breakeven / structure), and the runner cannot move stops yet (moveStop or the first-target fill status is missing); it cannot run until that is available',
  '这个版本还没有完成的回测报告': 'This version has no completed backtest report yet',
  '尚未注册 ASP 身份,发布会跳过;请到信号市场 → 发布注册': 'No ASP identity is registered, so publishing will be skipped; register under Signal Market → Publish',
  // POST /api/strategy-runs、PATCH /api/strategy-runs/:id 启动/修改失败
  '请求体必须是对象': 'The request body must be an object',
  'version 必须是正整数': 'version must be a positive integer',
  '「每笔问我确认」已下线;请选 auto(直接做)/ agent(LLM 判断)/ jev(Jev 判断)/ signal_only(只发信号)。已在跑的 confirm 运行不受影响': '"Ask me to confirm every trade" has been removed; choose auto (trade directly) / agent (LLM judge) / jev (Jev judge) / signal_only (signals only). Runs already in confirm mode are not affected',
  '「每笔问我确认」已下线;请选 auto / agent / jev / signal_only': '"Ask me to confirm every trade" has been removed; choose auto / agent / jev / signal_only',
  '无效的 mode,只能是 auto / agent / jev / signal_only': 'Invalid mode; must be auto / agent / jev / signal_only',
  '无效的 market': 'Invalid market',
  '无效的 status': 'Invalid status',
  'symbols 必须是 1–30 个内部 USDT 符号': 'symbols must be 1–30 USDT symbols (such as BTCUSDT)',
  'risk_pct 必须在 (0,100]': 'risk_pct must be in (0,100]',
  'max_open 必须在 1–30': 'max_open must be between 1 and 30',
  'publish_asp 必须是布尔值': 'publish_asp must be true or false',
  'jev_shadow 必须是布尔值': 'jev_shadow must be true or false',
  'confirm 必须是 LIVE': 'confirm must be LIVE',
  '该策略已有运行': 'This strategy already has a run',
  '旧执行通道仍有持仓、待批线程或待对账新信号,请先处理再切换运行通道': 'The old execution venue still has positions, trades awaiting approval or new signals to reconcile; resolve them before switching',
  '实盘运行需要输入 LIVE 确认': 'Live runs require typing LIVE to confirm',
  '运行不存在': 'Run not found',
  '运行已暂停': 'Run paused',
  '运行已停止': 'Run stopped',
  '无效的事件游标': 'Invalid event cursor',
  'symbols_source 必须是对象': 'symbols_source must be an object',
  'symbols_source 需 fixed 或 radar(tier=short|swing|weekly, top_n=1–30 整数)': 'symbols_source must be fixed or radar (tier=short|swing|weekly, top_n = integer 1–30)',
  // GET /api/trading/sources(runtime.ts tradingSources)、AI 扫盘暂停/恢复、执行层参数读写
  'AI 扫盘': 'AI Scan',
  '突破-回踩(单一策略,v3)': 'Breakout-Retest (single strategy, v3)',
  '(空 playbook)': '(empty playbook)',
  '紧急停止中': 'Emergency stop is on',
  '工作流已暂停': 'Workflow paused',
  'AI 扫盘已暂停': 'AI Scan paused',
  'Thread Manager 已暂停': 'Thread Manager paused',
  '界面上要求扫描': 'Scan requested from the UI',
  '界面上点了「立即扫描」': 'Clicked "Scan now" in the UI',
  'AI 扫盘已暂停:不再扫描新机会,策略运行照常': 'AI Scan paused: no new opportunities are scanned; strategy runs continue as usual',
  'AI 扫盘已恢复': 'AI Scan resumed',
  '已有线程继续复查,策略运行不受影响': 'Open trades are still reviewed; strategy runs are not affected',
  'AI 扫盘已暂停,不开新仓': 'AI Scan paused, no new positions',
  '已生成设置提议卡,用户在界面上点确认才生效': 'A settings proposal card was created; it takes effect only after the user confirms it in the UI',
  '实盘通道改执行层参数需要输入 LIVE 确认': 'Changing execution settings on a live venue requires typing LIVE to confirm',
  '没有要改的执行层参数': 'No execution settings to change',
  '请求体必须是对象,如 {"min_stop_pct":0.5}': 'The request body must be an object, such as {"min_stop_pct":0.5}',
  'min_stop_pct 必须小于 max_stop_pct': 'min_stop_pct must be less than max_stop_pct',
  'ai_scan_paused 必须是布尔': 'ai_scan_paused must be true or false',
  '风险/杠杆/止损距离/净盈亏比/持仓与开仓上限/日亏停/仓位倍率属于执行层,改用 set_execution_policy(模拟盘区间内直接生效,否则生成提议);自动执行/执行通道只能由用户在界面上改': 'Risk, leverage, stop distance, net R:R, position and entry limits, the daily loss stop and the position-size multiplier are execution settings; use set_execution_policy instead (applied directly on paper within the allowed range, otherwise a proposal is created). Auto-execution and the execution venue can only be changed by the user in the UI',
  '请求体只能是 {"paused": true|false}': 'The request body must be exactly {"paused": true|false}',
  'since 必须是不晚于现在、且在 31 天内的毫秒时间戳': 'since must be a millisecond timestamp no later than now and within the last 31 days',
  // gates.ts / runtime.ts 开仓检查项(名字 + 理由)
  '止损ATR下限': 'Stop ATR minimum',
  '当前策略': 'Current strategy',
  '已关闭(min_stop_atr=0)': 'Off (min_stop_atr=0)',
  '做空止损高于入场价': 'Short stop above the entry price',
  '开仓被执行闸拒绝': 'Entry rejected by the execution checks',
  // research/backtest-report.ts 报告警告
  '这份回测没有按实盘的执行层阈值挡单,回测里能下的单到实盘可能下不出去': 'This backtest did not apply the live execution rules, so orders placed in the backtest may be rejected in live trading',
};

/** 我们自己的 OKX.AI ASP 简介英文版(中文原文见 OKX.AI 身份卡 profileDescription,照原意翻)。 */
export const ASP_PROFILE_EN = 'Trading Swarm is a multi-agent trading team. Strategies are validated in the research lab with full-history backtests; at run time, code scans assets candle by candle under each strategy\'s rules and computes entry / stop / target, covering spot and perpetuals. Signals only describe the plan a rule triggered; they are not investment advice. Please manage your own risk.';

let exactCache: Map<string, string> | null = null;

/** 精确表 + 从 agent-registry / bots 常量按键拉链出的英文(源文改了,拉链自动跟上新原文)。 */
function exactMap(): Map<string, string> {
  if (exactCache) return exactCache;
  const m = new Map<string, string>([...Object.entries(RESEARCH_EXACT_EN), ...Object.entries(CATALOG_EXACT_EN), ...Object.entries(EXACT_EN)]);
  for (const role of BOT_ROLES) {
    const spec = AGENT_REGISTRY[role];
    const en = AGENT_EN[role];
    m.set(spec.tagline, en.tagline);
    m.set(spec.loop.cadence, en.cadence);
    for (const n of spec.loop.graph.nodes) if (en.nodes[n.id]) m.set(n.label, en.nodes[n.id]!);
  }
  for (const [name, t] of Object.entries(CHAT_TOOL_CATALOG)) {
    const en = TOOL_EN[name];
    if (!en) continue;
    m.set(t.summary, en.summary);
    m.set(t.doc, en.doc);
  }
  // 交易页来源卡片的原因码标签(execution-policy.ts REASON_LABELS):按原因码拉链;精确表里已有的中文(紧急停止、已暂停…)保持原译
  for (const [code, zh] of Object.entries(REASON_LABELS)) {
    const en = REASON_EN[code];
    if (en && !m.has(zh)) m.set(zh, en);
  }
  exactCache = m;
  return m;
}

// ---------------------------------------------------------------- 整句模板

const MONTH = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const month = (n: string): string => MONTH[Number(n)] ?? `month ${n}`;
const horizon = (h: string): string => HORIZON_EN[h] ?? h;

type Rule = [RegExp, (...m: string[]) => string];

/** 整串锚定的模板:命中就用(捕获组里的中文会再走一遍 englishText)。 */
const SENTENCES: Rule[] = [
  // main.ts 依赖哨兵、radar.ts 筛选完成(楼层团队动态标题)
  [/^依赖已恢复:(.+)$/, (_, d) => `Dependency recovered: ${d}`],
  [/^依赖不可用:(.+)$/, (_, d) => `Dependency unavailable: ${d}`],
  [/^(短线\(12h\)|中线\(3d\)|周线) 筛选完成:(\d+) 币,前 (\d+):(.*)$/,
    (_, h, n, k, top) => `${horizon(h!)} screen done: ${n} coins, top ${k}: ${top === '无候选' ? 'no candidates' : top!.replace(/、/g, ', ')}`],
  // info.ts:信息员模型总结失败的兜底(/api/market-state/history 里的旧记录)
  [/^模型总结失败\([\s\S]*\),以下只有数值。$/, () => 'Model summary unavailable for this run.'],
  // events-calendar.ts CALENDAR_2026
  [/^FOMC 利率决议\((\d+) 月\)$/, (_, m) => `FOMC rate decision (${month(m!)})`],
  [/^美国 CPI\((\d+) 月数据\)$/, (_, m) => `US CPI (${month(m!)} data)`],
  [/^美国非农就业\((\d+) 月数据\)$/, (_, m) => `US nonfarm payrolls (${month(m!)} data)`],
  // screener.ts 提案说明
  [/^(短线\(12h\)|中线\(3d\)|周线):筛了 (\d+) 个币,取契合度前 (\d+) 个。应用只改 watchlist,不动风险\/杠杆\/执行。$/,
    (_, h, n, k) => `${horizon(h!)}: screened ${n} symbols, took the top ${k} by fit. Applying only changes the watchlist; risk, leverage and execution are untouched.`],
  // universe-okx.ts 每日全市场扫描说明
  [/^每日全市场扫描\(OKX\):全集 (\d+) 个\(已排除稳定币\/包装币\),24h 成交额前 (\d+) 个按中线口径\(4h 打分、1d 确认\)算指标,(\d+) 张卡、(\d+) 个候选;其余 (\d+) 个只按 24h 成交额排序\(见 \/api\/universe\)。零模型;应用只改 watchlist。$/,
    (_, all, heavy, cards, cands, rest) => `Daily OKX full-market scan: ${all} instruments (stablecoins/wrapped tokens excluded); the top ${heavy} by 24h volume are scored on the mid-term basis (4h scoring, 1d confirmation): ${cards} cards, ${cands} candidates; the other ${rest} are only ranked by 24h volume (see /api/universe). Zero model calls; applying only changes the watchlist.`],
  [/^还没有每日全市场扫描$/, () => 'No daily full-market scan yet'],
  // evolution.ts 进化页单日记录标题:<币> <scan|review> → <动作>:<判断 headline>(headline 再单独译)
  [/^(\S+) (scan|review|\S+) → ([\w失败]+):([\s\S]+)$/, (_, sym, mode, act, head) => `${sym} ${mode} → ${act === '失败' ? 'failed' : act}: ${englishText(head!)}`],
  // context.ts 信息员候选证据:模型写的理由 + 固定尾注
  [/^(做多|做空)候选:([\s\S]*)\(只是线索,需按 playbook 重新判断\)$/, (_, side, why) => `${side === '做多' ? 'Long' : 'Short'} candidate: ${englishText(why!)} (a lead only; re-judge per the playbook)`],
  // 批量候补的 IR 标签(research/batch/families.ts:batch·<族> <参数> <市场方向> <周期>[ · 判断要素])
  [/^batch·(趋势突破|均线趋势\+波动率目标|均线金叉纯信号离场|回踩均线限价|震荡均值回归|SMC 结构|横截面动量|资金费套利) (\S+) (现货多|永续多|永续空) (\S+)( · 判断要素)?$/,
    (_, fam, param, side, tf, judge) => `batch·${({ 趋势突破: 'trend breakout', '均线趋势+波动率目标': 'MA trend + volatility target', 均线金叉纯信号离场: 'MA cross, signal-only exit', 回踩均线限价: 'MA pullback limit', 震荡均值回归: 'range mean reversion', 'SMC 结构': 'SMC structure', 横截面动量: 'cross-sectional momentum', 资金费套利: 'funding carry' } as Record<string, string>)[fam!]} ${param} ${({ 现货多: 'spot long', 永续多: 'perp long', 永续空: 'perp short' } as Record<string, string>)[side!]} ${tf}${judge ? ' · judgment factors' : ''}`],
  // 我们自己的 ASP 简介(OKX.AI 身份卡 / profileDescription):按前缀认,平台侧文本略有改动也能换成英文版
  [/^Trading Swarm 是一个多 agent 交易团队[\s\S]*$/, () => ASP_PROFILE_EN],
  // 买方订阅栏标签(asp-agent/agent.ts subscriptionDisplay)
  [/^试用中(?: · 剩 (?:(\d+) 天 )?(\d+) 小时)? · (到期转付费|到期不续费)$/, (_, d, h, r) => `On trial${h !== undefined ? ` · ${d ? `${d}d ` : ''}${h}h left` : ''} · ${r === '到期转付费' ? 'converts to paid at expiry' : 'no renewal at expiry'}`],
  [/^已取消 · 试用至 (.+ UTC)$/, (_, t) => `Cancelled · trial until ${t}`],
  [/^进行中 · 至 (.+ UTC)( · 自动续费| · 已关闭续费)?$/, (_, t, r) => `Active · until ${t}${r === ' · 自动续费' ? ' · auto-renew' : r ? ' · renewal off' : ''}`],
  [/^已结束\((\w+)\)$/, (_, st) => `Ended (${st})`],
  [/^状态未知\(代码 (\d+)\)$/, (_, c) => `Unknown status (code ${c})`],
  [/^被拒:([\s\S]*)$/, (_, r) => (r === '平台未给出原因' ? 'Rejected: no reason given by the platform' : hasCjk(r!) ? 'Rejected (reason from OKX in Chinese; see the listing)' : `Rejected: ${r}`)],
];

// ---------------------------------------------------------------- 短语拼译(结果必须不含中文才采用)

const FLAG_EN: Record<string, string> = {
  回踩确认: 'retest_confirmed', 失效确认: 'invalidation_confirmed', 结构转弱: 'structure_weakened', 论点趋势翻转: 'thesis_trend_flipped',
  压缩成立: 'compression_met', 扩张成立: 'expansion_met', 极值成立: 'extreme_met', 震荡成立: 'ranging_met', 偏离成立: 'deviation_met', 已跑掉: 'ran_away', 量能枯竭: 'volume_dried_up',
};

/** 模型理由里派生数的来源标注(系统规则 2b 要求的格式「(由 E9.20根高 与 E9.ATR% 算出)」)里常见的证据字段名 */
const FIELD_EN: Record<string, string> = {
  距: 'distance', 量比: 'vol ratio', 现价: 'price', 收盘: 'close', 最高: 'high', 最低: 'low', 开盘: 'open', 入场: 'entry', 入场价: 'entry price',
  止损: 'stop', 止盈: 'target', 突破位: 'breakout level', 浮盈: 'unrealized P&L', 权益: 'equity', 数量: 'qty', 均价: 'avg price', 标记价: 'mark price',
  资金费率: 'funding rate', 持仓量: 'open interest', 涨跌幅: 'change', 门槛: 'threshold', 上限: 'limit', 下限: 'minimum',
};
const fieldEn = (name: string): string => {
  const bars = /^(\d+) ?根(高|低)(点)?$/.exec(name);
  if (bars) return `${bars[1]}-bar ${bars[2] === '高' ? 'high' : 'low'}`;
  return FIELD_EN[name] ?? name;
};
const formulaEn = (f: string): string => f.replace(/(E\d+)\.([^\s()（）×*/+\-,，;；与和]+)/g, (_, e: string, name: string) => `${e}.${fieldEn(name)}`).replace(/ ?(与|和) ?/g, ' and ');
const PHRASES: Rule[] = [
  // 派生数来源标注:「(由 <公式> 算出)」→「(computed from <公式>)」;模型也会写成「(by E9.距)」
  [/[(（]由 ([^()（）]*(?:[(（][^()（）]*[)）][^()（）]*)*) 算出[)）]/g, (_, f) => `(computed from ${formulaEn(f!)})`],
  [/\(by (E\d+\.[^\s()]+(?:[^()]*)?)\)/g, (_, f) => `(by ${formulaEn(f!)})`],
  // 模型旧输出里的派生数标注与「万」单位
  [/\(由 ([^()]*(?:\([^()]*\)[^()]*)*) 算出\)/g, (_, f) => `(computed from ${f})`],
  [/([\d.]+) ?万美元/g, (_, n) => { const v = Number(n) * 1e4; return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}K`; }],
  [/\(([\d.]+)万\)/g, (_, n) => ` (${(Number(n) / 100).toFixed(2)}M)`],
  [/(\d+)根高(?!点)/g, (_, n) => `${n}-bar high`],
  // 活动流标题「[perp] SOLUSDT 触发:<kind>」(runtime.ts TRIGGER_LABEL)
  // triggers.ts 美股开/收盘窗口
  [/美股开盘前 (\d+) 分钟,开盘前后波动通常放大/g, (_, n) => `${n} min before the US equity open; volatility usually expands around the open`],
  [/美股刚开盘 (\d+) 分钟,波动放大、假突破多/g, (_, n) => `US equities opened ${n} min ago; volatility is elevated and false breakouts are common`],
  [/美股收盘前 (\d+) 分钟,收盘前常有方向性成交/g, (_, n) => `${n} min before the US equity close; directional flow is common into the close`],
  [/美股刚收盘 (\d+) 分钟/g, (_, n) => `US equities closed ${n} min ago`],
  [/触发:(急拉急跌|突破|EMA 交叉|放量|回踩|交易时段|资金费率|心跳|事件)/g, (_, k) => `trigger: ${({ 急拉急跌: 'fast move', 突破: 'breakout', 'EMA 交叉': 'EMA cross', 放量: 'volume spike', 回踩: 'retest', 交易时段: 'session', 资金费率: 'funding rate', 心跳: 'heartbeat', 事件: 'event' } as Record<string, string>)[k!]}`],
  // 模型旧输出里照抄的中文清单标签(新判断已经喂英文键)
  [/(回踩确认|失效确认|结构转弱|论点趋势翻转|压缩成立|扩张成立|极值成立|震荡成立|偏离成立|已跑掉|量能枯竭)[ =]?(yes|no|是|否)/g, (_, k, v) => `${FLAG_EN[k!]}=${v === '是' ? 'yes' : v === '否' ? 'no' : v}`],
  // triggers.ts 突破类触发的其余句式
  [/(\w+) 收盘 ([\d.]+) 跌破前 (\d+) 根低点 ([\d.]+)/g, (_, tf, px, n, lv) => `${tf} close ${px} broke below the prior ${n}-bar low ${lv}`],
  [/(\w+) 收在 (\d+) 根(高点上|低点下)\(首轮无前值对比\)/g, (_, tf, n, w) => `${tf} closed ${w === '高点上' ? 'above the' : 'below the'} ${n}-bar ${w === '高点上' ? 'high' : 'low'} (first pass, no prior value to compare)`],
  // 产品审核清单 hint
  [/^重新审核中\(资料有改动\)(?=[,;])/g, () => 'Re-review in progress (listing changed)'],
  [/^审核中(?=[,;])/g, () => 'Under review'],
  [/^已注册 #(\d+)$/g, (_, id) => `Registered #${id}`],
  [/^已上架 (\d+) 个产品$/g, (_, n) => `${n} products listed`],
  [/,等 OKX 审核结果$/g, () => ', awaiting the OKX review result'],
  [/;按原因修改后重新提交$/g, () => '; fix per the reason and resubmit'],
  // 入站信号解析错误(asp-agent/inbox.ts)
  [/^analysis:signal_type=(\w+) 不是可跟信号,只留痕$/g, (_, t) => `analysis: signal_type=${t} is not a followable signal; recorded only`],
  [/^action (.+) 认不出$/g, (_, a) => `action ${a} not recognized`],
  [/^(\w+) 在未来超过允许偏差,不采信$/g, (_, k) => `${k} is further in the future than allowed; ignored`],
  [/^(\w+) 解析不出时间:期限不可信,隔离$/g, (_, k) => `${k} does not parse as a time: expiry untrusted, quarantined`],
  [/^(\w+) 早于 published_at:期限不可信,隔离$/g, (_, k) => `${k} is earlier than published_at: expiry untrusted, quarantined`],
  // 回测评分分项说明(research/analyzer.ts)
  [/^最大回撤 (-?[\d.]+)%$/g, (_, v) => `Max drawdown ${v}%`],
  [/^盈亏因子 ([\d.]+)$/g, (_, v) => `Profit factor ${v}`],
  [/^年化 (-?[\d.]+)% vs 持有 (-?[\d.]+)%$/g, (_, a, b) => `Annualized ${a}% vs buy-and-hold ${b}%`],
  [/^总超额 (-?[\d.]+)%\(年化不可用\)$/g, (_, v) => `Total excess ${v}% (annualized unavailable)`],
  [/^样本外年化 (-?[\d.]+)% \/ 样本内 (-?[\d.]+)%$/g, (_, a, b) => `Out-of-sample annualized ${a}% / in-sample ${b}%`],
  [/^样本内年化 (-?[\d.]+)% 不为正,样本外 (-?[\d.]+)%$/g, (_, a, b) => `In-sample annualized ${a}% is not positive; out-of-sample ${b}%`],
  [/^每笔期望 (-?[\d.]+)%$/g, (_, v) => `Expectancy per trade ${v}%`],
  // 日线状态(market.ts dailyRegime):text 与 ema_stack
  [/日线多头排列\(牛\)/g, () => 'Daily bullish EMA stack (bull)'],
  [/日线空头排列\(熊\)/g, () => 'Daily bearish EMA stack (bear)'],
  [/日线无趋势\(震荡\)/g, () => 'Daily no trend (range)'],
  [/日线高波动/g, () => 'Daily high volatility'],
  [/价([<>])(EMA\d+)/g, (_, op, e) => `Price${op}${e}`],
  [/波动率处于近 (\d+) 日 (\d+)% 分位/g, (_, n, p) => `volatility at the ${p}th percentile of the last ${n} days`],
  [/(\d+) 日 ([+-]?[\d.]+)%/g, (_, n, v) => `${n}d ${v}%`],
  [/日 ATR ([\d.]+)%/g, (_, v) => `daily ATR ${v}%`],
  [/距 (EMA\d+) ([+-]?[\d.]+)%/g, (_, e, v) => `${v}% from ${e}`],
  // 模型早期输出里夹的中文片段(派生数来源标注等)
  [/由 (E\d+\.[\w%]+) 得 /g, (_, ref) => `derived from ${ref}: `],
  [/距离 /g, () => 'distance '],
  [/ ?追单 cap/g, () => ' chase cap'],
  [/追单上限/g, () => 'chase cap'],
  [/;样本重叠\(同一段偏离会被连续多根重复计数\),只作先验;没有盘中 tick,只用高低区间判断触及/g, () => '; samples overlap (one deviation episode is counted on several consecutive bars), so treat as a prior only; no intrabar ticks, touches judged from the high/low range'],
  [/OKX 上没有\(已跳过\):/g, () => 'Not listed on OKX (skipped): '],
  [/基于最近 (\d+) 根 (\w+)\(有效样本区 (\d+) 根\),偏离 (EMA\d+) 达到 k 个 (ATR\d+) 后、H 根内重新触及 (EMA\d+) 的历史比例;/g,
    (_, n, tf, v, e1, atr, e2) => `Based on the last ${n} ${tf} bars (${v} usable): historical share of cases where price, after deviating k × ${atr} from ${e1}, touches ${e2} again within H bars; `],
  [/^工作流已更新:([\w,]+)$/g, (_, k) => `Workflow updated: ${k}`],
  // 策略晋升缺口(strategies.ts promote_blocked,「;」串起来)
  [/OOS 成交不足 (\d+) 笔,还差 (\d+)/g, (_, n, m) => `OOS trades below ${n}, ${m} short`],
  [/OOS 净期望 CI 下界须 > 0/g, () => 'OOS net-expectancy CI lower bound must be > 0'],
  [/DSR 须 > 0/g, () => 'DSR must be > 0'],
  [/非负 regime 还差 (\d+) 桶/g, (_, n) => `${n} more non-negative regime buckets needed`],
  [/OOS 净最大回撤须 ≤ ([\d.]+)R/g, (_, r) => `OOS net max drawdown must be ≤ ${r}R`],
  [/影子实盘只有 (\d+) 笔,不足 (\d+) 笔,还差 (\d+)/g, (_, n, m, k) => `only ${n} shadow trades, below ${m}, ${k} short`],
  // 进化页方格 headline
  [/^(\d+) 次判断\((\d+) 次有动作,账本 (\d+) 行\),还没结算$/g, (_, a, b, c) => `${a} judgments (${b} with an action, ${c} ledger rows), not settled yet`],
  [/^(\d+) 笔结算,可与机械对照比的只有 (\d+) 笔\(< (\d+)\),不判色$/g, (_, a, b, c) => `${a} settled, only ${b} comparable with the mechanical baseline (< ${c}); not colored`],
  [/^(\d+) 笔结算,模型 (\S+) vs 机械 (\S+)$/g, (_, a, m, k) => `${a} settled, model ${m} vs mechanical ${k}`],
  [/^研究 (\d+) 问 \/ (\d+) run \/ (\d+) 回测 \/ (\d+) 改进环,完成率 ([^;]+);过门槛 (\d+),晋升 (\d+)$/g, (_, q, r, b, i, c, p, g) => `Research: ${q} questions / ${r} runs / ${b} backtests / ${i} improvement loops, completion ${c}; passed gate ${p}, promoted ${g}`],
  [/^(\d+) 次筛选全部失败$/g, (_, n) => `All ${n} screens failed`],
  [/^(\d+) 次筛选,前 (\d+) 候选 (\d+) 个,被跟进 (\d+) 个\(([^)]+)\),跟进后结算为正 (\S+)$/g, (_, n, k, c, f, fp, pos) => `${n} screens, ${c} top-${k} candidates, ${f} followed up (${fp}), ${pos} positive after follow-up`],
  [/^账户 (\S+),缺 BTC 价格对照$/g, (_, a) => `Account ${a}, BTC price baseline missing`],
  [/^账户 (\S+) vs BTC 持有 (\S+?)(?:\(剔除 (\d+) 次出入金跳变\))?$/g, (_, a, b, t) => `Account ${a} vs BTC buy-and-hold ${b}${t ? ` (${t} transfer jumps excluded)` : ''}`],
  [/^(\d+) 条告警\(去重\),high\/critical (\d+)(?:\(([\w/,、 ]+)\))?,拦截 (\d+)$/g, (_, n, h, k, b) => `${n} alerts (deduplicated), high/critical ${h}${k ? ` (${k})` : ''}, blocked ${b}`],
  [/^下单 (\d+) 笔\(失败 (\d+)\),交易所接口报错 (\d+) 次 \/ (\d+) 次判断\(([^)]+)\)$/g, (_, n, f, e, j, p) => `${n} orders (${f} failed), ${e} exchange API errors / ${j} judgments (${p})`],
  [/^复盘 (\d+) 批,教训提案 (\d+),已采纳 (\d+)(,有批次失败)?$/g, (_, n, p, a, f) => `${n} review batches, ${p} lesson proposals, ${a} adopted${f ? ', some batches failed' : ''}`],
  [/^(\d+) 次判断,没有模型调用$/g, (_, n) => `${n} judgments, no model calls`],
  [/^(\d+) 次模型调用,空转 (\d+)\(([^:]+):票池为空 (\d+) \/ 只许 HOLD (\d+)\),¥([\d.]+)$/g, (_, c, i, sh, pe, ho, cost) => `${c} model calls, ${i} idle (${sh}: empty pool ${pe} / HOLD-only ${ho}), ¥${cost}`],
  [/^巡检 (\d+) 次\(成功 (\d+)\),收到 (\d+) 条\(解析失败 (\d+)\),发出 (\d+) 条\(送达 (\d+)\)$/g, (_, r, ok, i, pf, o, d) => `${r} patrols (${ok} ok), ${i} received (${pf} parse failures), ${o} sent (${d} delivered)`],
  [/还没有带议会的扫描记录;票池配置 (\S+)/g, (_, p) => `No council-backed scan records yet; pool config ${p}`],
  // 信息员活动标题:「信息员:<regime>,偏<bias>」
  [/信息员:(趋势向上|趋势向下|区间震荡|高波动|方向不明),偏(多|空|中性)/g, (_, r, b) => `Info scout: ${({ 趋势向上: 'trending up', 趋势向下: 'trending down', 区间震荡: 'range-bound', 高波动: 'high volatility', 方向不明: 'unclear direction' } as Record<string, string>)[r!]}, ${({ 多: 'long', 空: 'short', 中性: 'neutral' } as Record<string, string>)[b!]} bias`],
  // 票池分配器
  [/在池 (\d+) 天,不满最短驻留 (\d+) 天,本轮不动/g, (_, a, b) => `in the pool ${a} days, below the ${b}-day minimum stay; unchanged this round`],
  [/票池不变\(([\w,]+)\):没有一条候选比在池的更好,或都卡在驻留\/冷却上/g, (_, p) => `Pool unchanged (${p}): no candidate beats the ones in the pool, or all are held by minimum stay / cooldown`],
  [/只有 (\d+) 笔已结算\(期望门槛要 (\d+) 笔\),连亏 (\d+) 笔/g, (_, n, m, l) => `only ${n} settled trades (expectancy needs ${m}), losing streak ${l}`],
  [/状态 (\w+),还没到 paper,不进票池/g, (_, st) => `status ${st}, not yet at paper; not in the pool`],
  // 矩阵研究结论 / 进度
  [/没有找到通过门槛的策略。/g, () => 'No strategy passed the gate. '],
  [/没有能直接上实盘的策略,但有 (\d+) 组值得先用模拟盘看看:候补 (\d+) 组\(只差样本数 \/ 显著性,可先用模拟盘观察;候补不算通过\)。/g,
    (_, a, b) => `No strategy is ready for live trading, but ${a} groups are worth paper-trading first: ${b} candidates (short only on sample size / significance; watch them on paper; candidates do not count as passing). `],
  [/(\d+) 个可评估格子;主因分布:/g, (_, n) => `${n} evaluable cells; main reasons: `],
  [/样本不足 (\d+)/g, (_, n) => `insufficient sample ${n}`],
  [/执行不支持 (\d+)/g, (_, n) => `execution unsupported ${n}`],
  [/;另有 (\d+) 格不适用、(\d+) 格仅研究\(3m\/5m\)/g, (_, a, b) => `; plus ${a} cells not applicable, ${b} cells research-only (3m/5m)`],
  [/\(Jev 两段式:只对候补测了 Jev,补跑 (\d+) 格,另 (\d+) 格没补跑\)/g, (_, a, b) => ` (Jev two-stage: Jev tested on candidates only, ${a} cells re-run, ${b} not re-run)`],
  [/\(历史回放:这段历史已被人看过,只能算回放证据,进实盘前还要前向验证\)/g, () => ' (historical replay: this period has been seen before, so it only counts as replay evidence; forward validation is required before live)'],
  // 闸门句式(episode error / reducer.reason 里是「闸名: 理由」用 ; 串起来),数字原样
  [/持仓计划: /g, () => 'Holding plan: '],
  [/主周期ATR\/入场价格缺失，无法建立持仓契约/g, () => 'primary-timeframe ATR / entry price missing, cannot build the holding contract'],
  [/策略ATR尺度: /g, () => 'Strategy ATR scale: '],
  // 自由判断的 ATR 尺度选项(context.ts renderFreeAtrChoices)
  [/自由判断 horizon=(\w+) /g, (_, h) => `No strategy bound, horizon=${h} `],
  [/ATR=缺失\(不可选\)/g, () => 'ATR=missing (not selectable)'],
  [/;可选倍数1\/1\.5\/2\/3\(下限([\d.]+)\);在proposal\.risk_plan填写atr_timeframe与stop_atr_multiple,atr_timeframe只能从这里选。先选能放在结构外的最小倍数和较短周期;倍数越大、周期越长,止损越宽,净RR要求的目标也越远。止损还需在结构外,止盈必须引用独立目标;不要为凑RR推远目标。/g, (_, f) => `; multiples 1/1.5/2/3 (floor ${f}); set atr_timeframe and stop_atr_multiple in proposal.risk_plan, and pick atr_timeframe from this list only. Start with the smallest multiple and shorter timeframe that still puts the stop beyond structure: a bigger multiple or longer timeframe means a wider stop and a farther target to reach the net R:R. The stop must also sit beyond structure, the target must cite an independent level, and don't push the target out just to improve R:R.`],
  [/(\w+) ATR=([\d.]+)，选择([\d.]+)倍，实际([\d.]+)倍；策略下限([\d.]+)倍/g, (_, tf, atr, c, a, f) => `${tf} ATR=${atr}, chose ${c}×, actual ${a}×; strategy floor ${f}×`],
  [/净盈亏比: /g, () => 'Net reward/risk: '],
  [/净RR=([\w.]+|不可计算)，需≥([\d.]+)；往返成本预算(\d+)bps/g, (_, rr, min, bps) => `net RR=${rr === '不可计算' ? 'not computable' : rr}, needs ≥${min}; round-trip cost budget ${bps}bps`],
  [/结构失效价: 失效价须位于入场的不利一侧与硬止损之间，不从自由文本漂移/g, () => 'Structural invalidation: the invalidation price must sit between the adverse side of entry and the hard stop, not drift from free text'],
  [/今日已开 (\d+)\/(\d+)/g, (_, a, b) => `opened today ${a}/${b}`],
  [/信心 ([\d.]+)\(需 ≥ ([\d.]+)\)/g, (_, c, m) => `confidence ${c} (needs ≥ ${m})`],
  [/([\d.]+)%\(允许 ([\d.]+)%–([\d.]+)%\)/g, (_, d, a, b) => `${d}% (allowed ${a}%–${b}%)`],
  // 行情接口限频
  [/HTTP 429\(限频熔断中,(\d+)s 后再试\)/g, (_, n) => `HTTP 429 (rate-limit breaker open, retry in ${n}s)`],
  // 触发说明
  [/(\d+) 分钟内 急拉 ([\d.]+)%\(阈值 ([\d.]+)%\)/g, (_, m, p, t) => `pump ${p}% within ${m} min (threshold ${t}%)`],
  [/(\d+) 分钟内 急跌 ([\d.]+)%\(阈值 ([\d.]+)%\)/g, (_, m, p, t) => `dump ${p}% within ${m} min (threshold ${t}%)`],
  [/(\w+) 回踩 (EMA\d+) ([\d.]+)\(距 ([\d.]+)%,近 (\d+) 根 ([+-]?[\d.]+)%\)/g, (_, tf, ema, px, d, n, ch) => `${tf} retest of ${ema} ${px} (${d}% away, last ${n} bars ${ch}%)`],
  [/(\w+) 收盘 ([\d.]+) 突破前 (\d+) 根(高|低)点 ([\d.]+)/g, (_, tf, px, n, hl, lv) => `${tf} close ${px} broke the prior ${n}-bar ${hl === '高' ? 'high' : 'low'} ${lv}`],
  [/(\w+) (EMA\d+) (上|下)穿 (EMA\d+)\(([\d.]+) vs ([\d.]+)\)/g, (_, tf, a, d, b, x, y) => `${tf} ${a} crossed ${d === '上' ? 'above' : 'below'} ${b} (${x} vs ${y})`],
  [/(\w+) 偏空/g, (_, tf) => `${tf} bearish`],
  [/(\w+) 偏多/g, (_, tf) => `${tf} bullish`],
  // 市场事件 / 触发说明(必须排在通用的「N 分钟」「量比」之前)
  [/事件窗口内:/g, () => 'In event window: '],
  [/(\w+) 成交量异动:/g, (_, s) => `${s} volume spike: `],
  [/这根 /g, () => 'this bar '],
  [/\(已开始 (\d+) 分钟,可信度 (\w+)\)/g, (_, n, c) => ` (started ${n} min ago, credibility ${c})`],
  [/\((\w+) K 线 (\d\d:\d\d) UTC 收盘\)/g, (_, tf, t) => ` (${tf} candle closed ${t} UTC)`],
  [/触发:事件/g, () => 'trigger: event'],
  [/触发:回踩/g, () => 'trigger: retest'],
  [/触发:突破/g, () => 'trigger: breakout'],
  [/触发:EMA 交叉/g, () => 'trigger: EMA cross'],
  [/急拉 ([\d.]+)%/g, (_, p) => `pump ${p}%`],
  [/急跌 ([\d.]+)%/g, (_, p) => `dump ${p}%`],
  [/值班简报:/g, () => 'Duty brief: '],
  [/过去 (\d+)h:(\d+) 次角色任务,/g, (_, h, n) => `Last ${h}h: ${n} role tasks, `],
  // 模型旧记录里照抄的清单布尔值(新判断已经喂 yes/no)
  [/=是/g, () => '=yes'],
  [/=否/g, () => '=no'],
  [/ is 是\b/g, () => ' is yes'],
  [/ is 否/g, () => ' is no'],
  // 交接 / 研究日志 / 简报
  [/研究记录:/g, () => 'Research log: '],
  [/(\d+)\/(\d+) 版本 × (\d+) 币:/g, (_, a, b, c) => `${a}/${b} versions × ${c} symbols: `],
  [/无 setup/g, () => 'no setup'],
  [/(\d+) 个非突破族版本量不出/g, (_, n) => `${n} non-breakout versions not measurable`],
  [/(\d+) 币失败/g, (_, n) => `${n} symbols failed`],
  [/\(机械期望,不是策略成绩\)/g, () => ' (mechanical expectancy, not strategy performance)'],
  [/;无晋升/g, () => '; no promotion'],
  [/;自动闭环:/g, () => '; autopilot: '],
  [/(-?[\d.]+|n\/a)R\/(\d+)笔/g, (_, r, n) => `${r}R/${n} trades`],
  [/(短线\(12h\)|中线\(3d\)|周线) ?筛选:/g, (_, h) => `${horizon(h!)} screen: `],
  [/建议观察 /g, () => 'suggest watching '],
  [/没有契合度够高的候选/g, () => 'no candidate with a high enough fit'],
  [/\(筛了 (\d+) 币,(\d+) 个失败\)/g, (_, n, f) => ` (screened ${n} symbols, ${f} failed)`],
  [/\(筛了 (\d+) 币\)/g, (_, n) => ` (screened ${n} symbols)`],
  [/(\d+) 条待阅/g, (_, n) => `${n} pending review`],
  [/风控无告警/g, () => 'no risk alerts'],
  [/风控 (\w+)\((\d+) 条开放\)/g, (_, l, n) => `risk ${l} (${n} open)`],
  [/无平仓/g, () => 'no closed trades'],
  [/平仓 (\d+) 笔,胜 (\d+) 负 (\d+),合计 ([+-]?[\d.]+)R/g, (_, n, w, l, r) => `${n} closed, ${w} won / ${l} lost, total ${r}R`],
  [/总敞口 ([\d.]+)×\((\w+)\)/g, (_, x, q) => `gross exposure ${x}× (${q})`],
  [/总敞口 ([\d.]+)×,(\d+) 个风险簇/g, (_, x, n) => `gross exposure ${x}×, ${n} risk clusters`],
  [/无账户快照/g, () => 'no account snapshot'],
  // 名册 presence
  [/(\d+) 条交接待阅/g, (_, n) => `${n} handoffs to review`],
  [/下次 (短线\(12h\)|中线\(3d\)|周线)筛选/g, (_, h) => `next ${horizon(h!)} screen`],
  [/上次实验 (\d+)h 前,(\d+) 笔新平仓/g, (_, h, n) => `last experiment ${h}h ago, ${n} new closed trades`],
  [/(\d+) 个判断排队/g, (_, n) => `${n} judgments queued`],
  [/(\d+) 条 warn 告警待阅/g, (_, n) => `${n} warn alerts to review`],
  // 筛选卡 / 全市场扫描理由
  [/OKX (现货|永续),24h 成交额第 (\d+|\?) \/ (\d+)/g, (_, mk, r, of) => `OKX ${mk === '现货' ? 'spot' : 'perp'}, 24h volume rank ${r} / ${of}`],
  [/契合 ([\d.]+)\((\d+)\/(\d+) 条通过,(\d+) 条差一点\)/g, (_, s, p, t, near) => `Fit ${s} (${p}/${t} conditions passed, ${near} near miss)`],
  [/契合 ([\d.]+)\((\d+)\/(\d+) 条通过\)/g, (_, s, p, t) => `Fit ${s} (${p}/${t} conditions passed)`],
  [/近 (\d+) 天机械期望 ([+-]?[\d.]+)R,(\d+) 笔/g, (_, d, r, n) => `${d}-day mechanical expectancy ${r}R, ${n} trades`],
  [/样本只有 (\d+) 笔,期望不可当结论/g, (_, n) => `Only ${n} trades; expectancy is not conclusive`],
  [/还差:/g, () => 'Missing: '],
  [/ATR% ≥ 分周期门槛/g, () => 'ATR% ≥ per-timeframe floor'],
  [/确认周期方向明确\(高周期只做否决\)/g, () => 'Confirmation timeframe has a clear direction (higher timeframe only vetoes)'],
  [/确认周期偏多/g, () => 'confirmation timeframe bullish'],
  [/确认周期偏空/g, () => 'confirmation timeframe bearish'],
  [/(\d+) 根内收破突破位/g, (_, n) => `close beyond the breakout level within ${n} bars`],
  [/(\d+) 根内收破压缩区间/g, (_, n) => `close beyond the squeeze range within ${n} bars`],
  [/(\d+) 根前突破/g, (_, n) => `breakout ${n} bars ago`],
  [/日线状态不反对该方向/g, () => 'daily regime does not oppose the direction'],
  [/带宽分位 ≤ (\d+)% 或 squeeze ≥ (\d+) 根/g, (_, p, n) => `bandwidth percentile ≤ ${p}% or squeeze ≥ ${n} bars`],
  [/带宽 (\d+) 根分位 ([\d.]+)%/g, (_, n, p) => `bandwidth ${n}-bar percentile ${p}%`],
  [/squeeze (开|关) 连续 (\d+) 根/g, (_, on, n) => `squeeze ${on === '开' ? 'on' : 'off'} for ${n} bars`],
  [/扩张量比/g, () => 'expansion volume ratio'],
  [/资金费率绝对值不极端/g, () => 'funding rate not extreme'],
  [/\|费率\|/g, () => '|funding|'],
  [/\|(\d+) 天 z\|/g, (_, d) => `|${d}-day z|`],
  [/距结算 > (\d+) 分钟/g, (_, n) => `> ${n} min to funding settlement`],
  [/震荡\(日线 range 或 ADX < (\d+)\)/g, (_, n) => `ranging (daily range or ADX < ${n})`],
  [/历史回归比例/g, () => 'historical reversion rate'],
  [/≥([\d.]+)ATR\/(\d+)根:回归 (\d+)%\(样本 (\d+)(?:,中位 (\d+) 根)?\)/g, (_, k, h, p, n, med) => `≥${k}ATR/${h} bars: reverts ${p}% (n=${n}${med ? `, median ${med} bars` : ''})`],
  [/距突破位/g, () => 'distance to breakout'],
  [/当根量比 /g, () => 'current bar vol ratio '],
  [/突破那根 /g, () => 'breakout bar '],
  [/当根 /g, () => 'current bar '],
  [/量比/g, () => 'vol ratio'],
  [/未成立/g, () => ' not met'],
  [/市价上限/g, () => 'market-order cap'],
  [/门槛/g, () => 'threshold'],
  [/上限/g, () => 'cap'],
  [/偏离 /g, () => 'deviation '],
  [/当前 /g, () => 'current '],
  [/距 (EMA\d+) ≥/g, (_, e) => `distance to ${e} ≥`],
  [/距 ([+-]?[\d.]+) ATR/g, (_, n) => `${n} ATR away`],
  [/同向\(偏多\)/g, () => 'aligned (bullish)'],
  [/同向\(偏空\)/g, () => 'aligned (bearish)'],
  [/不同向/g, () => 'not aligned'],
  [/同向/g, () => ' aligned'],
  [/日线 /g, () => 'daily '],
  [/(\d+) 分钟/g, (_, n) => `${n} min`],
  // 活动流标题的动作词(放在「做多/做空」等通用词之前没关系,它们不重叠)
  [/出策略:/g, () => 'strategy signal: '],
  [/做多/g, () => 'long'],
  [/做空/g, () => 'short'],
  [/限价 /g, () => 'limit '],
  [/市价/g, () => 'market'],
  [/止损 /g, () => 'stop '],
  // 信息员 key_points 的证据标签
  [/\[数据\]/g, () => '[data]'],
  // 标点收尾
  [/、/g, () => ', '],
];

// ---------------------------------------------------------------- 组合句(前缀 + 可译的余下部分;最后兜底,结果带中文就不用)

/**
 * 交易页三层(§9.56)里代码拼起来的句子:「币 原因」「检查项名:理由」「基础闸拒绝:…」、预检的执行层核对结论和修改建议、
 * 工作流/执行层参数变更的活动标题。整串、按段都试过仍译不了时才走这里;余下部分递归 englishText,整句还带中文 → null(不采用)。
 */
type ComposeRule = [RegExp, (...m: string[]) => string | null];

// 入场方式检查(entry-policy.ts entryStyleGate / finalEntryCheck)与发送前复查(runtime.ts executeOpenInner 的 abort)
const SIDE_EN: Record<string, string> = { 上: 'above', 下: 'below' };
const zoneEn = (z: string): string => (z === '按结构自定' ? 'set it from the structure' : z);
/** 「名字(理由);名字(理由)」按最外层括号切开;理由里可以再有括号和分号 */
function splitGateItems(s: string): { name: string; reason: string | null }[] | null {
  const items: { name: string; reason: string | null }[] = [];
  let depth = 0, start = 0, open = -1;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '（') { if (depth === 0) open = i; depth++; }
    else if (c === ')' || c === '）') { depth--; if (depth < 0) return null; }
    else if ((c === ';' || c === '；' || c === undefined) && depth === 0) {
      const part = s.slice(start, i).trim();
      if (part) {
        if (open > start && /[)）]$/.test(part)) items.push({ name: s.slice(start, open).trim(), reason: s.slice(open + 1, i).trim().replace(/[)）]$/, '') });
        else items.push({ name: part, reason: null });
      }
      start = i + 1; open = -1;
    }
  }
  return depth === 0 ? items : null;
}
const gateNameEn = (n: string): string => exactMap().get(n) ?? englishText(n);
const ENTRY_KIND_EN: Record<string, string> = { 市价: 'Market', 等待型限价: 'Waiting limit', 立刻成交的限价: 'Immediately-filling limit', '限价(身份未证明)': 'Limit (type not proven)' };
const keyList = (k: string): string => k.split(/[、,]\s*/).map((x) => x.trim()).filter(Boolean).join(', ');
const suggest = (lead: string | undefined, text: string): string => (lead ? `Suggestion: ${text}` : text);
const FIT_SOURCE_EN: Record<string, string> = { 回测订单: 'backtest orders', 回测: 'backtest candidates', 实盘候选: 'live candidates' };
const FIT_PART_EN: Record<string, string> = { 止损低于下限: 'stop below the minimum', '止损小于 ATR 下限': 'stop under the ATR minimum', 止损过宽: 'stop too wide', 净RR不足: 'net R:R too low' };
const COMPOSED: ComposeRule[] = [
  // 算数量的说明(gates.ts computeSizing,多条用「;」拼)与组合检查(portfolio.ts evaluateImpact)
  // 「最小下单量风险 … ;要 … 权益才能…」里自带分号,按段翻时两半各自也要认得
  [/^最小下单量风险 ([\d.]+) U > 预算 ([\d.]+) U$/, (_, risk, budget) => `The minimum order size risks ${risk} U, more than the ${budget} U budget`],
  [/^要 ([\d.]+) U 权益才能按 ([\d.]+)% 做 (\S+)\(容差 (\d+)%,拒单\)$/, (_, eq, pct, sym, tol) => `trading ${sym} at ${pct}% needs ${eq} U of equity (tolerance ${tol}%, rejected)`],
  [/^(\S+) 无行情,用持仓自带标记价$/, (_, sym) => `${sym}: no market data, used the position's own mark price`],
  [/^(\S+) 挂单 (\S+) 无法定价$/, (_, sym, id) => `${sym} open order ${id} could not be priced`],
  [/^名义超过权益×([\d.]+),按上限钳制$/, (_, k) => `Notional above ${k}× equity, capped at the limit`],
  [/^低于交易所最小名义 ([\d.]+) USDT,抬到最小名义\(实际风险 ([\d.]+) USDT\)$/, (_, n, r) => `Below the exchange minimum notional of ${n} USDT, raised to the minimum (actual risk ${r} USDT)`],
  [/^交易所最小名义 ([\d.]+) 高于本地名义上限 ([\d.]+),拒单$/, (_, n, cap) => `The exchange minimum notional ${n} is above the local notional cap ${cap}, rejected`],
  [/^最小下单量风险 ([\d.]+) U > 预算 ([\d.]+) U;要 ([\d.]+) U 权益才能按 ([\d.]+)% 做 (\S+)\(容差 (\d+)%,拒单\)$/,
    (_, risk, budget, eq, pct, sym, tol) => `The minimum order size risks ${risk} U, more than the ${budget} U budget; trading ${sym} at ${pct}% needs ${eq} U of equity (tolerance ${tol}%, rejected)`],
  [/^账户快照质量 (\S+?)(?:\(([^)]*)\))?,不能据此放行新开仓$/, (_, q, note) => `Account snapshot quality is ${q}${note ? ` (${englishText(note)})` : ''}, so new trades cannot be approved on it`],
  [/^(\S+) 不在风险簇表里\(unknown\),不新增未知簇风险$/, (_, sym) => `${sym} is not in the risk cluster table (unknown), so no new risk is added to an unknown cluster`],
  [/^成交后总敞口 ([\d.]+)× 权益 > 上限 ([\d.]+)×$/, (_, a, b) => `Gross exposure after the fill ${a}× equity > limit ${b}×`],
  [/^最坏净敞口 (-?[\d.]+)× 权益 > 上限 ([\d.]+)×$/, (_, a, b) => `Worst-case net exposure ${a}× equity > limit ${b}×`],
  [/^风险簇 (\S+) 敞口 ([\d.]+)× 权益 > 上限 ([\d.]+)×$/, (_, c, a, b) => `Risk cluster ${c} exposure ${a}× equity > limit ${b}×`],
  [/^聚合止损预算 ([\d.]+)% 权益 > 上限 ([\d.]+)%$/, (_, a, b) => `Combined stop budget ${a}% of equity > limit ${b}%`],
  [/^已有 (\S+) 缺止损保护\(名义 ([\d.]+) USDT\),先补保护再加风险$/, (_, syms, n) => `${syms.split('/').join(', ')} already lack stop protection (notional ${n} USDT); add protection before taking more risk`],
  // 判断记录 reducer:「提议被拒:检查名(理由);检查名(理由)」
  [/^提议被拒:([\s\S]+)$/, (_, rest) => {
    const items = splitGateItems(rest!);
    if (!items) return null;
    return `Proposal rejected: ${items.map((x) => (x.reason === null ? englishText(x.name) : `${gateNameEn(x.name)} (${englishText(x.reason)})`)).join('; ')}`;
  }],
  // 入场方式检查
  [/^限价 ([\d.]+) 在现价 ([\d.]+) 的(上|下)方会立刻成交,等同市价追单:距突破位 ([\d.?]+) ATR 已超过上限 ([\d.]+) ATR;改挂回踩区\(参考 ([^)]*)\)$/,
    (_, p, m, side, d, x, z) => `Limit ${p} is ${SIDE_EN[side!]} the current price ${m}, so it would fill at once, the same as chasing at market: ${d} ATR from the breakout level is over the ${x} ATR limit. Place it in the pullback zone instead (reference: ${zoneEn(z!)})`],
  [/^市价追单被拒:距突破位 ([\d.?]+) ATR 已超过市价上限 ([\d.]+) ATR;改挂限价\(参考区 ([^)]*)\)$/,
    (_, d, x, z) => `Market chase rejected: ${d} ATR from the breakout level is over the ${x} ATR market limit. Use a limit order instead (reference zone: ${zoneEn(z!)})`],
  [/^limit_only:(市价|限价 ([\d.]+) 会立刻成交,等同市价)开仓一律拒\(该策略规则没有 entry_mode=market_ok\)$/,
    (_, what, p) => `limit_only: ${p ? `limit ${p} would fill at once, the same as a market order, so` : 'market entries are'} always rejected (this strategy's rules do not set entry_mode=market_ok)`],
  [/^限价 ([\d.]+) 在现价 ([\d.]+) 的(上|下)方,会立刻成交\(marketable limit = 市价绕过\);回踩未确认只许挂在不利侧等$/,
    (_, p, m, side) => `Limit ${p} is ${SIDE_EN[side!]} the current price ${m} and would fill at once (a marketable limit is a way around the market-order rule); until the pullback is confirmed, only orders waiting on the far side are allowed`],
  [/^市价开仓要求可执行价新鲜:(?:这个价已经是 (\d+)ms 之前的\(上限 (\d+)ms\)|取不到可执行价),拒$/,
    (_, age, cap) => `A market entry needs a fresh price: ${age ? `this price is ${age}ms old (limit ${cap}ms)` : 'no executable price available'}, rejected`],
  [/^回踩未确认时必须证明这是等待型限价:(?:没有可用的限价|可执行价不新鲜\((\d+)ms > (\d+)ms\)),按 fail closed 拒$/,
    (_, age, cap) => `Until the pullback is confirmed the order must be proven to be a waiting limit: ${age ? `the price is stale (${age}ms > ${cap}ms)` : 'no usable limit price'}, so it is rejected`],
  [/^(市价|立刻成交的限价)追单被拒:成交价 ([\d.]+) 距冻结突破位 ([\d.]+) 已 ([\d.]+) ATR,超过上限 ([\d.]+) ATR$/,
    (_, k, p, lv, d, x) => `${k === '市价' ? 'Market' : 'Immediately-filling limit'} chase rejected: fill price ${p} is ${d} ATR from the frozen breakout level ${lv}, over the ${x} ATR limit`],
  [/^等待型限价挂得太远:挂单价 (\S+) 距冻结突破位 ([\d.]+) 有 ([\d.]+) ATR,超过上限 ([\d.]+) ATR —— 换成限价不等于没在追$/,
    (_, p, lv, d, x) => `Waiting limit placed too far: order price ${p} is ${d} ATR from the frozen breakout level ${lv}, over the ${x} ATR limit (switching to a limit order is still chasing)`],
  [/^(市价|等待型限价|立刻成交的限价|限价\(身份未证明\)):距冻结突破位 (n\/a|[\d.]+ ATR)\(上限 ([\d.]+)\)(,时机待回踩)?$/,
    (_, k, d, x, wait) => `${ENTRY_KIND_EN[k!]}: ${d} from the frozen breakout level (limit ${x})${wait ? ', waiting for the pullback' : ''}`],
  [/^回踩已确认但已走出 ([\d.]+) ATR\(市价上限 ([\d.]+)\),追单成本过高$/, (_, d, x) => `Pullback confirmed but price has moved ${d} ATR away (market limit ${x}); chasing costs too much`],
  [/^回踩未确认\(距突破位 ([\d.]+) ATR\),按策略规则应挂限价等回踩$/, (_, d) => `Pullback not confirmed (${d} ATR from the breakout level); the strategy rules call for a limit order that waits for the pullback`],
  // 发送前复查(平仓原因 / 意图错误)
  [/^发送前持仓计划重闸: ([^;]+);原计划不改价$/, (_, names) => `Pre-send holding plan recheck failed: ${names!.split('/').map((n) => gateNameEn(n.trim())).join(', ')}; the original plan was not repriced`],
  [/^发送前数量硬闸:([\s\S]+)$/, (_, r) => `Pre-send size check failed: ${englishText(r!)}`],
  [/^发送前组合硬闸:([\s\S]+)$/, (_, r) => `Pre-send portfolio check failed: ${englishText(r!)}`],
  [/^发送前重闸拒绝:([\s\S]+)$/, (_, r) => `Rejected by the pre-send recheck: ${englishText(r!)}`],
  [/^发送前入场方式重闸:([\s\S]+)$/, (_, r) => `Pre-send entry-type recheck failed: ${englishText(r!)}`],
  [/^设杠杆失败:([\s\S]*)$/, (_, r) => `Setting leverage failed: ${englishText(r!)}`],
  [/^设保证金模式失败:([\s\S]*)$/, (_, r) => `Setting the margin mode failed: ${englishText(r!)}`],
  // 漏斗样例「SOLUSDT 止损距离:…」「SOLUSDT:模型调用失败」、活动流「SOLUSDT <事件原文>」
  [/^([A-Z0-9]{2,20}USDT)( |:)([\s\S]+)$/, (_, sym, sep, rest) => `${sym}${sep === ':' ? ': ' : ' '}${englishText(rest!)}`],
  // strategy runner 基础闸拒绝(多条检查项用「;」拼)、回测执行层拒单
  [/^基础闸拒绝:([\s\S]+)$/, (_, rest) => `Blocked by basic checks: ${englishText(rest!)}`],
  [/^执行层:([\s\S]+)$/, (_, rest) => `Execution rules: ${englishText(rest!)}`],
  [/^未应用:([\s\S]+)$/, (_, rest) => `Not applied: ${englishText(rest!)}`],
  // 检查项「名字:理由」(名字要在精确表里)
  [/^([^:;\n]{1,30}):([\s\S]+)$/, (_, name, reason) => { const n = exactMap().get(name!); return n === undefined ? null : `${n}: ${englishText(reason!)}`; }],
  // strategy-run.ts Jev 判断事件、临时失败重试
  [/^Jev 放行:([\s\S]*)$/, (_, r) => `Jev approved: ${englishText(r!)}`],
  [/^Jev 跳过:([\s\S]*)$/, (_, r) => `Jev skipped: ${englishText(r!)}`],
  [/^Jev 不可用,按跳过:([\s\S]*)$/, (_, r) => `Jev not available, skipped: ${englishText(r!)}`],
  [/^临时失败,(\d+) 秒后重试:([\s\S]*)$/, (_, n, r) => `Temporary failure, retrying in ${n}s: ${englishText(r!)}`],
  // 活动流 / 日志:工作流与执行层参数变更
  [/^工作流已更新:([\w、, ]+?)(?:\(未应用:([\s\S]*)\))?$/, (_, k, err) => `Workflow updated: ${keyList(k!)}${err ? ` (not applied: ${englishText(err)})` : ''}`],
  [/^agent 改了执行层参数\(模拟盘直改区间内\):([\w、, ]+)$/, (_, k) => `Agent changed execution settings (within the range it may change directly on paper): ${keyList(k!)}`],
  [/^执行层参数已更新:([\w、, ]+)$/, (_, k) => `Execution settings updated: ${keyList(k!)}`],
  [/^(agent 在模拟盘直接|用户)改了执行层:([\s\S]*)$/, (_, who, d) => `${who === '用户' ? 'User' : 'Agent (on paper, directly)'} changed execution settings: ${d}`],
  [/^对话提议改执行层:([\w、, ]+)\((实盘通道|超出 agent 直改区间:([\w、, ]+))\),等待确认$/,
    (_, k, why, out) => `Chat proposed changing execution settings: ${keyList(k!)} (${out ? `outside the agent's direct range: ${keyList(out)}` : 'live venue'}), waiting for confirmation`],
  // sources[].playbook.name:playbook 第一行
  [/^(.+)\(单一策略,(v[\w.]+)\)$/, (_, name, v) => `${englishText(name!)} (single strategy, ${v})`],
  // 预检 execution_policy_mismatch:「<来源>按当前执行层会被拒掉 N%(拒/查:分项),样本止损中位 X%」+「;建议…」分段
  [/^(回测订单|回测|实盘候选)按当前执行层会被拒掉 (\d+)%\((\d+)\/(\d+):([^)]*)\)(?:,样本止损中位 ([\d.]+)%)?$/, (_, src, pct, rej, chk, parts, med) => {
    const ps = parts!.split('、').map((p) => { const m = /^(.+) (\d+)$/.exec(p); return m && FIT_PART_EN[m[1]!] ? `${FIT_PART_EN[m[1]!]}: ${m[2]}` : null; });
    if (!FIT_SOURCE_EN[src!] || ps.some((x) => x === null)) return null;
    return `${pct}% of ${FIT_SOURCE_EN[src!]} (${rej} of ${chk}) would be rejected by the current execution rules (${ps.join(', ')})${med ? `, median stop in the sample ${med}%` : ''}`;
  }],
  [/^(建议)?把策略止损倍数放宽到 ≥([\d.]+)×ATR\(按样本 ATR 中位 ([\d.]+)%,约 ([\d.]+)%\)$/, (_, s, k, a, p) => suggest(s, `widen the strategy stop to ≥${k}×ATR (median sample ATR ${a}%, about ${p}%)`)],
  [/^(建议)?把策略止损放宽到 ≥([\d.]+)%(?: 且 ≥([\d.]+)×ATR)?$/, (_, s, pct, k) => suggest(s, `widen the strategy stop to ≥${pct}%${k ? ` and ≥${k}×ATR` : ''}`)],
  [/^(建议)?把止损收紧到 ≤([\d.]+)%$/, (_, s, pct) => suggest(s, `tighten the stop to ≤${pct}%`)],
  [/^(建议)?止盈目标放到扣成本后 ≥([\d.]+)R\(或去掉不合理的近目标\)$/, (_, s, r) => suggest(s, `set take-profit targets at ≥${r}R after costs (or remove unrealistic near targets)`)],
  [/^(建议)?调整策略几何$/, (_, s) => suggest(s, 'adjust where the strategy places its stop and targets')],
];

function composed(s: string): string | null {
  for (const [re, fn] of COMPOSED) {
    const m = re.exec(s);
    if (!m) continue;
    const out = fn(...(m as unknown as string[]));
    if (out !== null && !hasCjk(out)) return out;
  }
  return null;
}

const PUNCT: [RegExp, string][] = [[/，/g, ', '], [/；/g, '; '], [/：/g, ': '], [/（/g, ' ('], [/）/g, ')'], [/。/g, '. ']];

// 译文只取决于原文(规则是常量),同一串反复出现(全市场扫描一次响应几千条)→ 有界缓存。
const textCache = new BoundedMap<string, string>(20_000);

export function englishText(s: string): string {
  if (!hasCjk(s)) return s;
  const exact = exactMap().get(s);
  if (exact !== undefined) return exact;
  const hit = textCache.get(s);
  if (hit !== undefined) return hit;
  const out = translate(s);
  if (s.length <= 4000) textCache.set(s, out);
  return out;
}

function translate(s: string): string {
  // <untrusted_data>中文新闻原文 —— 英文摘要</untrusted_data>:外部原文不翻,出口只留「——」后的英文;自家拼的内文(量能异动等)照译
  const u = s.replace(/<untrusted_data>([\s\S]*?)<\/untrusted_data>/g, (m, inner: string) => {
    const dash = /^([\s\S]*?) —— ([\s\S]*)$/.exec(inner);
    if (dash && hasCjk(dash[1]!) && !hasCjk(dash[2]!)) return `<untrusted_data>${dash[2]}</untrusted_data>`;
    const e = hasCjk(inner) ? englishText(inner) : inner;
    return `<untrusted_data>${e}</untrusted_data>`;
  });
  if (u !== s && !hasCjk(u.replace(/<untrusted_data>[\s\S]*?<\/untrusted_data>/g, ''))) return u;
  const base = u !== s ? u : s;
  // 外壳还有中文:把 untrusted 块当引文保护起来,外壳走整句/模板/切段
  const blocks: string[] = [];
  const shell = base.replace(/<untrusted_data>[\s\S]*?<\/untrusted_data>/g, (m) => `「\u0003${blocks.push(m) - 1}」`);
  const restore = (x: string): string => x.replace(/"?\u0003(\d+)"?/g, (_, i: string) => blocks[Number(i)]!).replace(/「\u0003(\d+)」/g, (_, i: string) => blocks[Number(i)]!);
  if (blocks.length) {
    const t = translateWhole(shell) ?? wholeTemplate(shell) ?? translateSegments(shell);
    if (t !== null) return restore(t);
  }
  return translateWhole(s) ?? wholeTemplate(s) ?? translateSegments(s) ?? composed(s) ?? s;
}

/** 整串(不切段)查数字模板:模板里本身带 ; 的句子要先整串试。 */
function wholeTemplate(s: string): string | null {
  const { tmpl, tokens } = templateOf(s.trim());
  const en = TEMPLATE_EN[tmpl];
  return en === undefined ? null : fillTemplate(en, tokens);
}

// ---------------------------------------------------------------- 分段 + 数字模板(详情接口里代码拼出来的长串)

/**
 * 模板化:把「」引文、数字、ASCII 标识符(币种、周期、指标、id…)换成 {0}{1}…,剩下的中文骨架去查 TEMPLATE_EN。
 * 骨架相同、只差数字/币种的句子共用一条英文;英文里按编号放回原值(引文内再试译一次,译不了原样放进英文引号)。
 */
const TOKEN = /「[^「」]*」|[+-]?\d[\d,.]*%?|[A-Za-z0-9_$][A-Za-z0-9_.:$%+\-/<>=|]*/g;
export function templateOf(core: string): { tmpl: string; tokens: string[] } {
  const tokens: string[] = [];
  const tmpl = core.replace(TOKEN, (m) => `{${tokens.push(m) - 1}}`);
  return { tmpl, tokens };
}
const fillTemplate = (en: string, tokens: string[]): string =>
  en.replace(/\{(\d+)\}/g, (m, i: string) => {
    const t = tokens[Number(i)];
    if (t === undefined) return m;
    if (t === 'trade-gate') return 'Trading Swarm'; // 提示词/说明里当产品名用的 trade-gate
    return t.startsWith('「') ? `"${englishText(t.slice(1, -1))}"` : t;
  });

const SEGMENT_SEP = /(\r?\n|；|;|。)/;
// 只有「」算引文(外部原文);ASCII 双引号里的中文多半是我们自己拼进字符串的 JSON,照样要译
const cjkOutsideQuotes = (s: string): boolean => hasCjk(s.replace(/「[^「」]*」/g, ''));

/**
 * 按 换行 / ; / 。 切段,每段先走整句规则,不行再查数字模板;有一段译不了就整串放弃(onMiss 收集缺的模板,给抽取脚本用)。
 * 第一遍按原文切;不行再走第二遍:字符串里拼进去的 JSON 值("…中文…")先逐个整体翻译,译不了的(如买方下单时写的需求原文)
 * 当外部引文占位保护起来(不参与切段、原样保留),再切段翻译外壳。
 */
export function translateSegments(s: string, onMiss?: (tmpl: string, example: string) => void): string | null {
  const first = segmentPass(s);
  if (first !== null || !/"[^"\n]*[\u3400-\u9fff][^"\n]*"/.test(s)) {
    if (first === null) segmentPass(s, onMiss);
    return first;
  }
  const kept: string[] = [];
  const pre = s.replace(/"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g, (m, t: string) => {
    const e = englishText(t);
    return hasCjk(e) ? `"\u0001${kept.push(t) - 1}\u0001"` : `"${e.replace(/"/g, "'")}"`;
  });
  const second = segmentPass(pre, onMiss);
  return second === null ? null : second.replace(/\u0001(\d+)\u0001/g, (_, i: string) => kept[Number(i)]!);
}

const FLAG_ZH: [string, string][] = Object.entries(FLAG_EN).map(([zh, en]) => [en, zh]);
/** 英文清单键还原成模板表里的中文标签形状:回踩确认在 review-metrics 里是「回踩确认 x」,在 entry-policy 里是「回踩确认=x」,两种都试。 */
function legacyFlagForms(core: string): string[] {
  if (!/(?:retest_confirmed|invalidation_confirmed|structure_weakened|thesis_trend_flipped|_met|ran_away|volume_dried_up|squeeze|consensus)=/.test(core)) return [];
  const base = (retestSep: string): string => {
    let x = core.replace(/squeeze=(yes|no)/g, '挤压 $1').replace(/consensus=/g, '共识=');
    for (const [en, zh] of FLAG_ZH) x = x.replace(new RegExp(`${en}=`, 'g'), en === 'retest_confirmed' ? `回踩确认${retestSep}` : `${zh}=`);
    return x;
  };
  const a = base(' '), b = base('=');
  return a === b ? [a] : [a, b];
}

function segmentPass(s: string, onMiss?: (tmpl: string, example: string) => void): string | null {
  const parts = s.split(SEGMENT_SEP);
  let ok = true;
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part === '；' || part === ';' ? '; ' : part === '。' ? '. ' : part;
    const core = part.trim();
    if (!core || !cjkOutsideQuotes(core)) return part;
    const lead = part.slice(0, part.indexOf(core));
    const trail = part.slice(part.indexOf(core) + core.length);
    const exact = exactMap().get(core);
    if (exact !== undefined) return lead + exact + trail;
    const whole = translateWhole(core);
    if (whole !== null) return lead + whole + trail;
    const { tmpl, tokens } = templateOf(core);
    let en = TEMPLATE_EN[tmpl];
    let useTokens = tokens;
    if (en === undefined) {
      // 英文评审版起喂给模型(也存进证据)的清单标签是英文键(squeeze=yes、retest_confirmed=no);模板表是按中文标签建的,
      // 这里还原成旧的中文标签形状再查一次(英文键 → 中文标签,yes/no 仍是占位符,译文里照样放回)
      for (const legacy of legacyFlagForms(core)) {
        const t = templateOf(legacy);
        if (TEMPLATE_EN[t.tmpl] !== undefined) { en = TEMPLATE_EN[t.tmpl]; useTokens = t.tokens; break; }
      }
    }
    if (en !== undefined) {
      // 模板译文按句首大写写的;接在「;」后面的段改成小写起头(缩写如 ATR / OKX 不动)
      const filled = fillTemplate(en, useTokens);
      const afterSemi = i > 0 && (parts[i - 1] === '；' || parts[i - 1] === ';');
      return lead + (afterSemi && /^[A-Z][a-z]/.test(filled) ? filled[0]!.toLowerCase() + filled.slice(1) : filled) + trail;
    }
    const comp = composed(core);
    if (comp !== null) return lead + comp + trail;
    ok = false;
    onMiss?.(tmpl, core);
    return part;
  });
  if (!ok) return null;
  return out.join('').replace(/\. ; /g, '; ').replace(/; {2,}/g, '; ').replace(/ +(\n|$)/g, '$1');
}

function translateWhole(s: string): string | null {
  for (const [re, fn] of SENTENCES) {
    const m = re.exec(s);
    if (m) return fn(...(m as unknown as string[]));
  }
  // 「」里是外部原文(新闻标题等):先挖出来占位,外壳译完再原样放回双引号里 —— 外部内容不翻,外壳不因它整句作废。
  const quoted: string[] = [];
  let out = s.replace(/「([^「」]*)」/g, (_, t: string) => ` \u0000${quoted.push(t) - 1}\u0000`);
  for (const [re, fn] of PHRASES) out = out.replace(re, (...m: unknown[]) => fn(...(m as string[])));
  for (const [re, to] of PUNCT) out = out.replace(re, to);
  if (hasCjk(out)) return null;
  // 引号里的也试着译一遍(量能异动这类自家模板);译不了的是外部原文,原样保留。
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `"${englishText(quoted[Number(i)]!)}"`);
  // 中文原句用半角 ,; 不带空格、括号紧贴前文;译成英文后补上空格(数字里的千分位逗号不动)。
  return out.replace(/,(?=\S)/g, ', ').replace(/(\d), (\d{3})(?!\d)/g, '$1,$2').replace(/;(?=\S)/g, '; ').replace(/([^\s(])\((?=[A-Za-z])/g, '$1 (').replace(/ {2,}/g, ' ');
}

// ---------------------------------------------------------------- 对象级覆盖

const isRole = (v: unknown): v is BotRole => typeof v === 'string' && (BOT_ROLES as string[]).includes(v);

const EN_DOC_DIR = fileURLToPath(new URL('../../agents/en/', import.meta.url));
const docCache = new Map<string, { mtime: number; size: number; text: string }>();

/** agents/en/<role>.md;缺文件时用英文名 + 英文简介拼一段,不回落中文。 */
export function englishAgentMd(role: BotRole, directory = EN_DOC_DIR): string {
  const file = `${directory}/${role}.md`;
  try {
    const st = statSync(file);
    const hit = docCache.get(file);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = readFileSync(file, 'utf8');
    docCache.set(file, { mtime: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    return `# ${AGENT_REGISTRY[role].name}\n\n## Who I am\n\n${BOT_EN[role].description}\n`;
  }
}

interface StrategyEn { name?: string; description?: string; ir_label?: string; ir_description?: string }
let strategyCache: { path: string; mtime: number; checked_at: number; table: Record<string, StrategyEn> } | null = null;
const STRATEGY_RECHECK_MS = 5_000;

/**
 * TG_PUBLIC_STRATEGY_EN 指向的 {strategies:{<strategy_id>:{name,description}}};没配或读不了就是空表。
 * 每个对象都会问一次,所以文件最多 5 秒 stat 一次(改了表不用重启网关)。
 */
export function strategyEnTable(now = Date.now()): Record<string, StrategyEn> {
  const path = process.env['TG_PUBLIC_STRATEGY_EN'] ?? '';
  if (!path) return {};
  if (strategyCache && strategyCache.path === path && now - strategyCache.checked_at < STRATEGY_RECHECK_MS) return strategyCache.table;
  try {
    const mtime = statSync(path).mtimeMs;
    if (strategyCache && strategyCache.path === path && strategyCache.mtime === mtime) {
      strategyCache.checked_at = now;
      return strategyCache.table;
    }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { strategies?: Record<string, StrategyEn> };
    const table = raw && typeof raw.strategies === 'object' && raw.strategies ? raw.strategies : {};
    strategyCache = { path, mtime, checked_at: now, table };
    return table;
  } catch {
    strategyCache = { path, mtime: -1, checked_at: now, table: {} };
    return {};
  }
}

/**
 * 按对象形状做强制覆盖,返回浅拷贝(不改调用方的对象)。认的形状:
 *   bot profile   {role, approval_boundary, …}    → name/description/approval_boundary/note/memory_scope.note
 *   agent 名册卡  {role, callsign, tagline, loop}   → tagline / loop.cadence
 *   agent 详情    {agent:{role}, agent_md}          → agent_md 换英文版
 *   研究策略      {id|strategy_id ∈ 覆盖表, name…}  → name/description(strategy_name 同理)
 */
/** 对象自己的研究策略 id(strategy_id,或 id 本身就是覆盖表里的策略);没有就是 null。project 用它往下传给内嵌对象。 */
export function ownStrategyId(obj: Record<string, unknown>): string | null {
  const table = strategyEnTable();
  if (typeof obj['strategy_id'] === 'string' && Object.hasOwn(table, obj['strategy_id'])) return obj['strategy_id'];
  if (typeof obj['id'] === 'string' && Object.hasOwn(table, obj['id'])) return obj['id'];
  return null;
}

export function englishObject(obj: Record<string, unknown>, inheritedSid: string | null = null): Record<string, unknown> {
  let out = obj;
  const patch = (fields: Record<string, unknown>): void => { out = { ...out, ...fields }; };
  const role = obj['role'];
  if (isRole(role) && 'approval_boundary' in obj) {
    const en = BOT_EN[role];
    const scope = obj['memory_scope'];
    patch({
      name: en.name,
      description: en.description,
      approval_boundary: en.approval_boundary,
      note: en.note,
      ...(scope && typeof scope === 'object' && !Array.isArray(scope) ? { memory_scope: { ...(scope as Record<string, unknown>), note: en.memory_note } } : {}),
    });
  }
  if (isRole(role) && 'callsign' in obj && 'tagline' in obj) {
    const loop = obj['loop'];
    patch({
      tagline: AGENT_EN[role].tagline,
      ...(loop && typeof loop === 'object' && !Array.isArray(loop) && 'cadence' in loop ? { loop: { ...(loop as Record<string, unknown>), cadence: AGENT_EN[role].cadence } } : {}),
    });
  }
  const agent = obj['agent'];
  if (typeof obj['agent_md'] === 'string' && agent && typeof agent === 'object' && isRole((agent as Record<string, unknown>)['role'])) {
    patch({ agent_md: englishAgentMd((agent as Record<string, unknown>)['role'] as BotRole) });
  }
  const table = strategyEnTable();
  const sid = typeof obj['id'] === 'string' && Object.hasOwn(table, obj['id']) ? obj['id']
    : typeof obj['strategy_id'] === 'string' && Object.hasOwn(table, obj['strategy_id']) ? obj['strategy_id'] : null;
  if (sid) {
    const en = table[sid]!;
    const fields: Record<string, unknown> = {};
    // {strategy_id, name}(没有自己的 id,如矩阵研究的 my_strategies)也算同一条策略的名字
    if (en.name && typeof obj['name'] === 'string' && (sid === obj['id'] || !('id' in obj))) fields['name'] = en.name;
    if (en.name && typeof obj['strategy_name'] === 'string') fields['strategy_name'] = en.name;
    if (en.description && typeof obj['description'] === 'string' && sid === obj['id']) fields['description'] = en.description;
    // 回测报告 {strategy_id, title}:标题就是策略名
    if (en.name && typeof obj['title'] === 'string' && hasCjk(obj['title']) && sid === obj['strategy_id']) fields['title'] = en.name;
    // 带 strategy_id、自己又不是策略的对象(回测报告):description 是 IR 说明
    if (sid !== obj['id'] && 'id' in obj && typeof obj['description'] === 'string' && hasCjk(obj['description'])) {
      const d = en.ir_description ?? en.description;
      if (d) fields['description'] = d;
    }
    patch(fields);
  }
  const irSid = ownStrategyId(obj) ?? inheritedSid;
  const ir = out['strategy_ir'];
  if (irSid && ir && typeof ir === 'object' && !Array.isArray(ir)) {
    const en = table[irSid]!;
    const irObj = ir as Record<string, unknown>;
    const irFields: Record<string, unknown> = {};
    const label = en.ir_label ?? en.name;
    const desc = en.ir_description ?? en.description;
    if (label && typeof irObj['label'] === 'string' && hasCjk(irObj['label'])) irFields['label'] = label;
    if (desc && typeof irObj['description'] === 'string' && hasCjk(irObj['description'])) irFields['description'] = desc;
    if (Object.keys(irFields).length) patch({ strategy_ir: { ...irObj, ...irFields } });
  }
  return out;
}

/** 不做字段剥离与脱敏、只做英文覆盖的深拷贝(OKX.AI 只读快照用:快照导出时已脱敏,owner 同样看到英文)。 */
export function englishDeep(value: unknown, depth = 0): unknown {
  if (depth > 30) return value;
  if (typeof value === 'string') return englishText(value);
  if (Array.isArray(value)) return value.map((v) => englishDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(englishObject(value as Record<string, unknown>))) out[k] = englishDeep(v, depth + 1);
    return out;
  }
  return value;
}
