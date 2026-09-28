/**
 * 后端文案英文化(评审版英文优先,2026-09-26)。
 *
 * 活动流标题、风控告警、交接摘要、判断的 reducer 理由、进化日报标题、agent 在岗状态这些字符串是网关用中文拼出来的,
 * 前端原样显示。这里用句式表把常见句式翻成英文,品种 / 数字 / 代码标识原样保留:
 *
 *   st('[perp] LINKUSDT 急跌 0.98%')   → en: '[perp] LINKUSDT sharp drop 0.98%'   zh: 原样
 *
 * - 只在 en 下生效;zh 原样返回。
 * - 匹配不上的原样显示,dev 下 console.warn 一次(去重),方便补句式。
 * - 句式来自 18811 真实数据(/api/activity 约 4000 条 + /api/risk/alerts + /api/overview + /api/bots +
 *   /api/evolution/daily),见 test/server-text-en.test.ts 的样本。
 * - 复合串先整句匹配,再按「;」拆段逐段匹配(网关常把多条原因用 ; 拼起来),全部段都认得才算命中。
 * - 新闻标题(「…」里的正文)和模型现写的总结不翻:那是外部内容 / 模型输出,硬翻会失真。
 */
import { getLang } from './i18n';

const N = String.raw`[-−+]?\d[\d,]*(?:\.\d+)?`;
const HAN = /[\u3400-\u9fff]/;

type Tr = (s: string) => string | null;
type Rule = [RegExp, (m: RegExpExecArray, tr: Tr) => string | null];

/** 小词表:方向 / 触发类型 / 行情状态 / 周期名等 */
const SIDE: Record<string, string> = { 做多: 'Long', 做空: 'Short' };
const TRIGGER: Record<string, string> = { 事件: 'event', 突破: 'breakout', 回踩: 'pullback', 放量: 'volume spike', 'EMA 交叉': 'EMA cross', 急跌: 'sharp drop', 急拉: 'sharp rally', 跌破: 'breakdown' };
const REGIME: Record<string, string> = { 高波动: 'high volatility', 方向不明: 'no clear direction', 区间震荡: 'range-bound', 趋势向上: 'uptrend', 趋势向下: 'downtrend', 低波动: 'low volatility' };
const BIAS: Record<string, string> = { 偏多: 'leaning long', 偏空: 'leaning short', 偏中性: 'neutral' };
const HORIZON: Record<string, string> = { 短线: 'Short-term', 中线: 'Mid-term', 长线: 'Long-term' };
const BACKEND: Record<string, string> = { '纸面模拟': 'Paper', 'OKX(官方 okx CLI)': 'OKX (official okx CLI)', 'OKX 模拟盘': 'OKX demo', '币安 Agentic 子账户': 'Binance Agentic sub-account' };

const list = (s: string) => s.replace(/、/g, ', ');
const backend = (s: string) => BACKEND[s.trim()] ?? s.trim();

/** 整句规则(内含「;」或必须整句认的长句) */
const WHOLE: Rule[] = [
  [new RegExp(`^这是你这台机器到交易所接口的网络/代理问题[\\s\\S]*?别让它每 (${N})–(${N}) 秒掐长连接;或换网络。(?:最近一次:([\\s\\S]*))?$`), (m) =>
    `This is a network/proxy issue between this machine and the exchange API, not an exchange rejection or a balance problem. The gateway handles it automatically: if a receipt is lost it checks the exchange first, then resends with the same order ID; at worst the stop is placed a few seconds late, and nothing is closed by mistake. To reduce it: route the exchange API directly in your proxy (Clash etc.) or switch to a stable node so it doesn't drop long connections every ${m[1]}–${m[2]} s, or change networks.${m[3] ? ` Last occurrence: ${m[3]}` : ''}`],
  [new RegExp(`^新开仓要求组件 ≤ (${N}) 秒\\(本通道每次账户读要起一次 CLI,天然就有几百秒延迟\\);下一次账户轮询回来就会自动恢复$`), (m) =>
    `New entries require data ≤ ${m[1]} s old (this channel spawns a CLI for every account read, so a few hundred seconds of lag is normal); it recovers automatically on the next account poll`],
  [new RegExp(`^行情快照 > (${N}) 分钟;这些币不能开仓\\(证据新鲜度闸\\)$`), (m) => `Market snapshot older than ${m[1]} min; these symbols can't be opened (evidence freshness gate)`],
  [new RegExp(`^已用 (${N}) 次\\(本地日历日\\)。设置里调高 daily_judgment_cap 或设 0 表示不限;你在对话里问问题不受此限制。$`), (m) =>
    `${m[1]} used (local calendar day). Raise daily_judgment_cap in Settings, or set 0 for unlimited; questions you ask in chat don't count.`],
  [/^持仓动作闸\(代码计算\)只允许 HOLD:(\w+);跳过模型$/, (m) => `Position action gate (computed in code) allows HOLD only: ${m[1]}; model skipped`],
  [/^值班简报:([\s\S]+)$/, (m, tr) => { const r = tr(m[1]!); return r === null ? null : `Duty brief: ${r}`; }],
  [/^风控:([\s\S]+?)(?: ×(\d+))?$/, (m, tr) => { const r = tr(m[1]!); return r === null ? null : `Risk: ${r}${m[2] ? ` ×${m[2]}` : ''}`; }],
  [/^模型总结失败\(([\s\S]*)\),以下只有数值。$/, (m) => `Model summary failed (${m[1]!.trim()}); numbers only below.`],
  [/^(矩阵研究|批量验证)完成:这次没有找到能用的策略\((.+)\)。$/, (m) => `Batch Validation finished: no usable strategy this time (${m[2]}).`],
  [/^走官方 okx CLI\(@okx_ai\/okx-trade-cli\)本地签名,密钥只在 ~\/\.okx\/config\.toml,网关只传 --profile。开仓时止损\/止盈作为附带单与开仓一次提交,行情走 OKX 公共 REST。$/, () =>
    'Uses the official okx CLI (@okx_ai/okx-trade-cli) with local signing; keys stay in ~/.okx/config.toml and the gateway only passes --profile. Stop loss / take profit are attached to the entry order in one submission; market data comes from the OKX public REST API.'],
];

// ── 矩阵研究 / 海选(gateway demo/research/matrix-study compute.ts conclusionOf、scorecard.ts luckOf/tierOf/gateText)
const CAUSE_EN: Record<string, string> = { 费用吃掉: 'eaten by fees', 样本不足: 'insufficient sample', 执行不支持: 'execution unsupported', 跑输持有: 'underperformed buy-and-hold' };
const causeDist = (d: string) => (d === '无' ? 'none' : d.split('、').map((x) => x.replace(/^(\S+) (\d+)$/, (_w, k: string, n: string) => `${CAUSE_EN[k] ?? k} ${n}`)).join(', '));
const REPLAY_ZH = '(历史回放:这段历史已被人看过,只能算回放证据,进实盘前还要前向验证)';
const REPLAY_EN = ' (historical replay: this history has been seen before, so it only counts as replay evidence; forward validation is still required before going live)';
const replay = (m?: string) => (m ? REPLAY_EN : '');
const RE_REPLAY = `(${REPLAY_ZH.replace(/[()]/g, '\\$&')})?`;
const CAND_ZH = '候补 (\\d+) 组\\(只差样本数 / 显著性,可先用模拟盘观察;候补不算通过\\)';
const candEn = (n: string) => `${n} paper candidates (only short on sample size / significance; can be watched on paper first; candidates don't count as passes)`;
const cellsEn = (applicable: string, fin?: string) => `${applicable} evaluable cells${fin ? `, ${fin} finalists failed on the holdout` : ''}`;
const MATRIX_WHOLE: Rule[] = [
  [new RegExp(`^(\\d+) 条策略在留出段通过 Holm 校正检验:(.+?)。(?:另有${CAND_ZH}。)?其余不合格主因:(.+?)${RE_REPLAY}$`), (m) =>
    `${m[1]} strategies passed the Holm-corrected test on the holdout: ${m[2]!.replace(/;/g, '; ')}.${m[3] ? ` Also ${candEn(m[3])}.` : ''} Main reasons for the rest: ${causeDist(m[4]!)}${replay(m[5])}`],
  [new RegExp(`^没有能直接上实盘的策略,但有 (\\d+) 组值得先用模拟盘看看:${CAND_ZH}。(\\d+) 个可评估格子(?:、(\\d+) 个 finalist 在留出段未通过)?;主因分布:(.+?);另有 (\\d+) 格不适用、(\\d+) 格仅研究\\(([^)]*)\\)${RE_REPLAY}$`), (m) =>
    `No strategy is ready for live trading, but ${m[1]} are worth watching on paper first: ${candEn(m[2]!)}. ${cellsEn(m[3]!, m[4])}; main reasons: ${causeDist(m[5]!)}; plus ${m[6]} cells not applicable and ${m[7]} research-only (${m[8]})${replay(m[9])}`],
  [new RegExp(`^没有找到通过门槛的策略。(\\d+) 个可评估格子(?:、(\\d+) 个 finalist 在留出段未通过)?;主因分布:(.+?);另有 (\\d+) 格不适用、(\\d+) 格仅研究\\(([^)]*)\\)${RE_REPLAY}$`), (m) =>
    `No strategy passed the gate. ${cellsEn(m[1]!, m[2])}; main reasons: ${causeDist(m[3]!)}; plus ${m[4]} cells not applicable and ${m[5]} research-only (${m[6]})${replay(m[7])}`],
  [new RegExp(`^试了 (\\d+) 个版本\\(本格 (\\d+) 个、这次研究 (\\d+) 个\\);(?:(选择段样本太少,算不出运气折扣,先当它是运气)|按这么多次试验折算,这组选择段成绩约 (${N}%|—) 的可能是运气(,更像碰巧 —— 先用模拟盘看前向表现)?(\\(DSR 不可用,按试验数做 Bonferroni\\))?)$`), (m) => {
    const head = `${m[1]} versions tried (${m[2]} in this cell, ${m[3]} in this study)`;
    if (m[4]) return `${head}; too few selection-period samples to estimate a luck discount, so treat it as luck for now`;
    return `${head}; adjusted for that many trials, there is about a ${m[5]} chance this selection-period result is luck${m[6] ? ' — more likely a fluke; watch forward performance on paper first' : ''}${m[7] ? ' (DSR unavailable; Bonferroni by trial count)' : ''}`;
  }],
];

/** 单段规则(按「;」拆开后逐段匹配) */
const SEGMENT: Rule[] = [
  // ── 活动流标题:[市场] 品种 …
  [/^\[(\w+)\] (\S+) 触发:(.+)$/, (m) => `[${m[1]}] ${m[2]} trigger: ${TRIGGER[m[3]!] ?? m[3]}`],
  [new RegExp(`^\\[(\\w+)\\] (\\S+) (急跌|急拉) (${N})%$`), (m) => `[${m[1]}] ${m[2]} ${TRIGGER[m[3]!]} ${m[4]}%`],
  [new RegExp(`^\\[(\\w+)\\] (\\S+) 出策略:(做多|做空) (?:限价 (${N})|市价),止损 (${N})$`), (m) => `[${m[1]}] ${m[2]} plan: ${SIDE[m[3]!]} ${m[4] ? `limit ${m[4]}` : 'market'}, stop ${m[5]}`],
  [new RegExp(`^\\[(\\w+)\\] (\\S+) (做多|做空) (?:(${N}) )?已成交 @ (${N})$`), (m) => `[${m[1]}] ${m[2]} ${SIDE[m[3]!]} ${m[4] ? `${m[4]} ` : ''}filled @ ${m[5]}`],
  [/^\[(\w+)\] (\S+) (做多|做空) 已平仓:(.+)$/, (m, tr) => `[${m[1]}] ${m[2]} ${SIDE[m[3]!]} closed: ${tr(m[4]!) ?? m[4]}`],
  [/^\[(\w+)\] (\S+) 提议(做多|做空)被代码闸拦下$/, (m) => `[${m[1]}] ${m[2]} ${SIDE[m[3]!]} proposal blocked by a code gate`],
  [/^\[(\w+)\] (\S+) 异常已解除$/, (m) => `[${m[1]}] ${m[2]} issue cleared`],
  [new RegExp(`^\\[(\\w+)\\] (\\S+) 止损已挂 @ (${N}),止盈 (${N})$`), (m) => `[${m[1]}] ${m[2]} stop placed @ ${m[3]}, take profit ${m[4]}`],
  [new RegExp(`^\\[(\\w+)\\] (\\S+) 止损已挂 @ (${N})$`), (m) => `[${m[1]}] ${m[2]} stop placed @ ${m[3]}`],
  [/^\[(\w+)\] 策略 (.+) (\S+) (做多|做空):组合经理过闸,已交执行$/, (m) => `[${m[1]}] Strategy ${m[2]} ${m[3]} ${SIDE[m[4]!]}: passed the Portfolio Manager gate, sent to execution`],
  [new RegExp(`^今日判断已达上限 (${N}) 次,后续判断已跳过$`), (m) => `Daily judgment cap of ${m[1]} reached; further judgments skipped`],
  [/^信息员:(.+?),(偏多|偏空|偏中性)$/, (m) => `Intel: ${REGIME[m[1]!] ?? m[1]}, ${BIAS[m[2]!]}`],
  [/^工作流已更新:(.+)$/, (m) => `Workflow updated: ${list(m[1]!)}`],
  [/^执行后端已切换为(.+)$/, (m) => `Execution backend switched to ${backend(m[1]!)}`],
  [/^(.+?) ?启动失败,已退回纸面模拟$/, (m) => `${backend(m[1]!)} failed to start; fell back to Paper`],
  [/^(.+?) ?已恢复,自动切回$/, (m) => `${backend(m[1]!)} recovered; switched back automatically`],
  [new RegExp(`^(短线|中线|长线)\\((\\w+)\\) 筛选完成:(${N}) 币,前 (${N}):(.+)$`), (m) => `${HORIZON[m[1]!]} (${m[2]}) screen done: ${m[3]} coins, top ${m[4]}: ${list(m[5]!)}`],
  [new RegExp(`^(短线|中线|长线)\\((\\w+)\\):筛了 (${N}) 个币,取契合度前 (${N}) 个。应用只改 watchlist,不动风险/杠杆/执行。$`), (m) => `${HORIZON[m[1]!]} (${m[2]}): screened ${m[3]} coins, kept the top ${m[4]} by fit. Applying only changes the watchlist, not risk, leverage or execution.`],
  [new RegExp(`^模型 (\\S+) ¥(${N})$`), (m) => `model ${m[1]} ¥${m[2]}`],
  [/^切换账户:原账户上还有未了结的东西$/, () => 'Account switch: the previous account still has open items'],
  [/^(\S+) 线程需要处理:(\w+)$/, (m) => `${m[1]} thread needs attention: ${m[2]}`],
  [new RegExp(`^(${N}) 笔订单状态不明$`), (m) => `${m[1]} orders in unknown state`],
  [new RegExp(`^(${N}) 笔状态不明的订单留在原账户,切回后再核对$`), (m) => `${m[1]} orders in unknown state left on the previous account; reconcile after switching back`],
  [new RegExp(`^启动时退回纸面后第 (${N}) 次重试成功$`), (m) => `Retry #${m[1]} succeeded after falling back to Paper at startup`],
  [new RegExp(`^(.+) 超时 (${N})ms\\(每分钟自动重试切回\\)$`), (m) => `${m[1]} timed out after ${m[2]}ms (retrying every minute to switch back)`],
  [new RegExp(`^(.+) 超时 (${N})ms$`), (m) => `${m[1]} timed out after ${m[2]}ms`],
  // ── 值班简报分段
  [new RegExp(`^过去 (${N})h:(${N}) 次角色任务,¥(${N})$`), (m) => `last ${m[1]}h: ${m[2]} role tasks, ¥${m[3]}`],
  [new RegExp(`^(${N}) 条待阅$`), (m) => `${m[1]} unread`],
  [new RegExp(`^风控 (\\w+)\\((${N}) 条开放\\)$`), (m) => `risk ${m[1]} (${m[2]} open)`],
  [/^无平仓$/, () => 'no closes'],
  [new RegExp(`^(${N}) 笔平仓$`), (m) => `${m[1]} closes`],
  [new RegExp(`^总敞口 (${N})×\\((\\w+)\\)$`), (m) => `gross exposure ${m[1]}× (${m[2]})`],
  // ── 风控告警
  [new RegExp(`^账户/行情组件过期 (${N}) 秒$`), (m) => `Account/market data stale for ${m[1]} s`],
  [/^账户快照不完整$/, () => 'Account snapshot incomplete'],
  [new RegExp(`^执行通道网络不稳:最近 (${N}) 分钟 (${N}) 次调用里 (${N}) 次连接被掐$`), (m) => `Execution channel unstable: ${m[3]} of ${m[2]} calls dropped in the last ${m[1]} min`],
  [new RegExp(`^(${N}) 个币行情过期/缺失:(.+)$`), (m) => `Market data stale/missing for ${m[1]} symbols: ${m[2]}`],
  [/^(\S+) 无行情,用持仓自带标记价$/, (m) => `${m[1]} has no quote; using the position's mark price`],
  [new RegExp(`^超过本通道允许的 (${N}) 秒一倍以上:账户大概率读不到了,先看执行页的通道状态$`), (m) => `More than twice the ${m[1]} s this channel allows: the account is probably unreadable; check the channel status on the Execution page`],
  [/^先核对再开新仓\(gates 已挡\)$/, () => 'Reconcile before opening new positions (gates are blocking)'],
  [/^止损单已恢复$/, () => 'Stop order restored'],
  [new RegExp(`^止损 (${N}),止盈 (${N})$`), (m) => `Stop ${m[1]}, take profit ${m[2]}`],
  [/^策略机械离场:(\w+)$/, (m) => `Mechanical strategy exit: ${m[1]}`],
  [/^界面上手动平仓\/撤单$/, () => 'Closed or cancelled manually in the UI'],
  // ── 触发详情
  [new RegExp(`^(${N}) 分钟内 (急跌|急拉) (${N})%\\(阈值 (${N})%\\)$`), (m) => `${TRIGGER[m[2]!] === 'sharp drop' ? 'Dropped' : 'Rallied'} ${m[3]}% within ${m[1]} min (threshold ${m[4]}%)`],
  [/^事件窗口内:(\w+)「([\s\S]+?)」\(已开始 (\d+) 分钟,可信度 (\w+)\)(?:\((\w+) K 线 (\d\d:\d\d) UTC 收盘\))?$/, (m, tr) => {
    const inner = tr(m[2]!) ?? m[2]!; // 新闻标题原样(外部内容);结构化异动句式能翻就翻
    return `In event window: ${m[1]} "${inner}" (started ${m[3]} min ago, credibility ${m[4]})${m[5] ? ` (${m[5]} bar closed ${m[6]} UTC)` : ''}`;
  }],
  [new RegExp(`^(\\S+) 成交量异动:(\\w+) 量比 (${N}),这根 (${N})%\\(ATR (${N})%\\)$`), (m) => `${m[1]} volume spike: ${m[2]} volume ratio ${m[3]}, this bar ${m[4]}% (ATR ${m[5]}%)`],
  [new RegExp(`^(\\S+) 资金费率极端:资金费率 (${N})%\\(\\|x\\| ≥ (${N})%\\)$`), (m) => `${m[1]} extreme funding: ${m[2]}% (|x| ≥ ${m[3]}%)`],
  [new RegExp(`^(\\w+) 量比 (${N}),这根 (${N})%\\(ATR (${N})%\\)(?:\\((\\w+) K 线 (\\d\\d:\\d\\d) UTC 收盘\\))?$`), (m) => `${m[1]} volume ratio ${m[2]}, this bar ${m[3]}% (ATR ${m[4]}%)${m[5] ? ` (${m[5]} bar closed ${m[6]} UTC)` : ''}`],
  [new RegExp(`^(\\w+) 收盘 (${N}) (跌破|突破)前 (${N}) 根(低点|高点) (${N})\\(量比 (${N})\\)(?:\\((\\w+) K 线 (\\d\\d:\\d\\d) UTC 收盘\\))?$`), (m) =>
    `${m[1]} close ${m[2]} broke ${m[3] === '跌破' ? 'below' : 'above'} the prior ${m[4]}-bar ${m[5] === '低点' ? 'low' : 'high'} ${m[6]} (volume ratio ${m[7]})${m[8] ? ` (${m[8]} bar closed ${m[9]} UTC)` : ''}`],
  [/^([\s\S]+?)\((\w+) K 线 (\d\d:\d\d) UTC 收盘\)$/, (m, tr) => { const r = tr(m[1]!); return r === null ? null : `${r} (${m[2]} bar closed ${m[3]} UTC)`; }],
  [new RegExp(`^(\\w+) 回踩 EMA(\\d+) (${N})\\(距 (${N})%,近 (\\d+) 根 (${N})%\\),(\\w+) (偏多|偏空|偏中性)$`), (m) => `${m[1]} pullback to EMA${m[2]} ${m[3]} (${m[4]}% away, last ${m[5]} bars ${m[6]}%), ${m[7]} ${BIAS[m[8]!]}`],
  [new RegExp(`^(\\w+) EMA(\\d+) (上穿|下穿) EMA(\\d+)\\((${N}) vs (${N})\\)$`), (m) => `${m[1]} EMA${m[2]} crossed ${m[3] === '上穿' ? 'above' : 'below'} EMA${m[4]} (${m[5]} vs ${m[6]})`],
  [/^(\w+) 收在 (\d+) 根(高点上|低点下)\(首轮无前值对比\)$/, (m) => `${m[1]} closed at a ${m[2]}-bar ${m[3] === '高点上' ? 'high' : 'low'} (first run, no prior value to compare)`],
  [new RegExp(`^资金费率 (${N})%\\(\\|x\\| ≥ (${N})%\\)$`), (m) => `Funding ${m[1]}% (|x| ≥ ${m[2]}%)`],
  [new RegExp(`^美股刚开盘 (${N}) 分钟,波动放大、假突破多$`), (m) => `US market opened ${m[1]} min ago: volatility up, frequent false breakouts`],
  [new RegExp(`^美股开盘前 (${N}) 分钟,开盘前后波动通常放大$`), (m) => `${m[1]} min before the US open: volatility usually rises around the open`],
  [new RegExp(`^美股收盘前 (${N}) 分钟,收盘前常有方向性成交$`), (m) => `${m[1]} min before the US close: directional flow is common into the close`],
  // ── 策略实验台 / 矩阵研究的交接摘要
  [/^第 (\d+) 代 (\S+?):(neighborhood|swap|diagnosis|生成器没有产出新变体)(?::([\s\S]+?))? → (未改进|晋升)$/, (m, tr) => {
    const body = m[3] === '生成器没有产出新变体' ? 'generator produced no new variant' : `${m[3]}: ${tr(m[4] ?? '') ?? m[4]}`;
    return `Gen ${m[1]} ${m[2]}: ${body} → ${m[5] === '晋升' ? 'promoted' : 'not improved'}`;
  }],
  [new RegExp(`^参数邻域:周期整体 ×(${N})\\(更灵敏、信号更多\\),同时是父策略的平台检验点([\\s\\S]*)$`), (m) => `Parameter neighborhood: all periods ×${m[1]} (more sensitive, more signals); also a plateau check for the parent${m[2]}`],
  [new RegExp(`^仓位:加波动率目标 (${N})%\\(每笔 (${N})% 可用资金 × min\\((${N}), 目标/入场前 (${N}) 天实现波动\\);批量研究里它压回撤最明显\\)([\\s\\S]*)$`), (m) => `Sizing: add a ${m[1]}% volatility target (${m[2]}% of available capital per trade × min(${m[3]}, target / realized vol over the ${m[4]} days before entry); the biggest drawdown reducer in batch research)${m[5]}`],
  [new RegExp(`^止损过紧:止损出场占比高且合计亏损,ATR 倍数放宽 (${N}) 倍给正常波动留空间([\\s\\S]*)$`), (m) => `Stop too tight: many stop-outs with a net loss; widen the ATR multiple ${m[1]}× to leave room for normal noise${m[2]}`],
  [new RegExp(`^止损过紧:改用结构止损\\(近 (${N}) 根最低价\\),止损放在结构失效处而不是固定距离([\\s\\S]*)$`), (m) => `Stop too tight: switch to a structural stop (lowest low of the last ${m[1]} bars), placed where the structure fails rather than at a fixed distance${m[2]}`],
  [new RegExp(`^资金闲置:追踪止损太近导致过早离场,倍数放宽 (${N}) 倍让趋势段拿得更久([\\s\\S]*)$`), (m) => `Idle capital: trailing stop too close causes early exits; widen the multiple ${m[1]}× to ride trends longer${m[2]}`],
  [new RegExp(`^利润集中:加一档 (${N})R 固定止盈锁定部分大波段\\(现货单仓,近似分档止盈\\)([\\s\\S]*)$`), (m) => `Concentrated profits: add a fixed ${m[1]}R take profit to bank part of big swings (single spot position, approximates scaled exits)${m[2]}`],
  [new RegExp(`^利润集中:少数几笔撑起全部利润、其余交易浮盈回吐,到 (${N})R 后止损上移保本([\\s\\S]*)$`), (m) => `Concentrated profits: a few trades carry all the profit while others give back gains; move the stop to breakeven at ${m[1]}R${m[2]}`],
  [new RegExp(`^样本不足:平仓少于 (${N}) 笔,信号周期缩短到 (${N}) 倍让信号更频繁([\\s\\S]*)$`), (m) => `Too few samples: fewer than ${m[1]} closed trades; shorten signal periods to ${m[2]}× for more signals${m[3]}`],
  [new RegExp(`^矩阵研究 (.+) × (.+):(${N}) 个变体排队$`), (m) => `Matrix study ${m[1]} × ${m[2]}: ${m[3]} variants queued`],
  // ── 矩阵研究档位理由(tierOf / gateText)与 notes
  [/^平仓 (\d+|—) 笔,不到 (\d+) 笔$/, (m) => `${m[1]} closed trades, fewer than ${m[2]}`],
  [/^只有 (\d+|—) 个时间块,不到 (\d+) 个$/, (m) => `only ${m[1]} time blocks, fewer than ${m[2]}`],
  [new RegExp(`^显著性不够\\(DSR (${N}|—),门槛 (${N})\\)$`), (m) => `not significant enough (DSR ${m[1]}, threshold ${m[2]})`],
  [/^没过:(.+)$/, (m) => `failed: ${m[1]}`],
  [/^选择段净收益不为正$/, () => 'selection-period net return not positive'],
  [/^没跑赢同敞口持有$/, () => 'did not beat exposure-matched buy-and-hold'],
  [new RegExp(`^回撤 (${N}%|—) 超过门槛 (${N}%)$`), (m) => `drawdown ${m[1]} above the ${m[2]} limit`],
  [/^评分卡 (\w+|无)\(至少 fair\)$/, (m) => `scorecard ${m[1] === '无' ? 'none' : m[1]} (needs at least fair)`],
  [/^平仓 (\d+) 笔,候补至少 (\d+) 笔$/, (m) => `${m[1]} closed trades; candidates need at least ${m[2]}`],
  [/^选择段门槛全过,没进最终验收名额$/, () => 'passed all selection gates but did not get a final-validation slot'],
  [/^原门槛全过,最终验收通过$/, () => 'passed all original gates and final validation'],
  [/^最终验收没通过$/, () => 'failed final validation'],
  [/^同一格的最终候选没过最终验收$/, () => "this cell's finalist failed final validation"],
  [/^选择段门槛全过,等最终验收$/, () => 'passed all selection gates; awaiting final validation'],
  [/^选择段门槛全过,搜索还没结束$/, () => 'passed all selection gates; search still running'],
  [/^执行不支持$/, () => 'execution unsupported'],
  [/^没有(?:评估)?成绩(?::([\s\S]+))?$/, (m) => `no results${m[1] ? `: ${m[1]}` : ''}`],
  [/^(?:(\w+):)?资产池只有 (\d+) 个资产,少于设计要求的 (\d+) 个,结论只作观察$/, (m) => `${m[1] ? `${m[1]}: ` : ''}the asset pool has only ${m[2]} assets, fewer than the ${m[3]} the design requires; treat the conclusion as observational only`],
  [/^这次研究跑在 v2 之前,盈亏因子没有记录,评分里该项按中性计$/, () => 'This study predates v2: profit factor was not recorded, so that score component is treated as neutral'],
  [/^旧评估未记录盈亏因子,按中性计$/, () => 'Older evaluation did not record profit factor; treated as neutral'],
  // ── 判断 reducer 理由(代码写死的几句)
  [/^没有优势$/, () => 'No edge'],
  [/^有苗头,记为观察$/, () => 'Early signs; added to watch'],
  [/^论点仍成立,继续持有$/, () => 'Thesis still valid; holding'],
  [/^代码已判定只能持有,跳过模型$/, () => 'Code allows hold only; model skipped'],
  // ── agent 在岗状态(presence.action)
  [new RegExp(`^(${N}) 条交接待阅$`), (m) => `${m[1]} handoffs to read`],
  [/^下次 ?(短线|中线|长线)\((\w+)\) ?筛选$/, (m) => `Next ${HORIZON[m[1]!]!.toLowerCase()} (${m[2]}) screen`],
  [/^扫描 (\S+)$/, (m) => `Scanning ${m[1]}`],
  [new RegExp(`^上次实验 (${N})h 前,(${N}) 笔新平仓$`), (m) => `Last experiment ${m[1]}h ago, ${m[2]} new closes`],
  [/^账户快照 stale$/, () => 'Account snapshot stale'],
  [new RegExp(`^(${N}) 条 (\\w+) 告警,停止新增风险$`), (m) => `${m[1]} ${m[2]} alerts; no new risk`],
  [new RegExp(`^(${N}) 笔平仓待批次\\(≥(${N}) 或 (${N})h\\)$`), (m) => `${m[1]} closes waiting for a batch (≥${m[2]} or ${m[3]}h)`],
  [/^接收入站投递$/, () => 'Receiving inbound deliveries'],
  // ── 进化日报标题(/api/evolution/daily headline)
  [/^当天没有(判断|信号收发|复盘|权益记录|筛选|研究活动|新告警|执行相关记录)$/, (m) => `No ${({ 判断: 'judgments', 信号收发: 'signals sent or received', 复盘: 'reviews', 权益记录: 'equity records', 筛选: 'screens', 研究活动: 'research activity', 新告警: 'new alerts', 执行相关记录: 'execution records' } as Record<string, string>)[m[1]!]} that day`],
  [new RegExp(`^下单 (${N}) 笔\\(失败 (${N})\\),交易所接口报错 (${N}) 次 / (${N}) 次判断\\((${N})%\\)$`), (m) => `${m[1]} orders (${m[2]} failed), ${m[3]} exchange API errors / ${m[4]} judgments (${m[5]}%)`],
  [new RegExp(`^(${N}) 次模型调用,空转 (${N})\\((${N})%:票池为空 (${N}) / 只许 HOLD (${N})\\),¥(${N})$`), (m) => `${m[1]} model calls, ${m[2]} idle (${m[3]}%: empty pool ${m[4]} / HOLD-only ${m[5]}), ¥${m[6]}`],
  [new RegExp(`^(${N}) 次筛选,前 (${N}) 候选 (${N}) 个,被跟进 (${N}) 个\\((${N})%\\),跟进后结算为正 (—|${N}%)$`), (m) => `${m[1]} screens, ${m[3]} top-${m[2]} candidates, ${m[4]} followed up (${m[5]}%), positive after follow-up ${m[6]}`],
  [new RegExp(`^研究 (${N}) 问 / (${N}) run / (${N}) 回测 / (${N}) 改进环,完成率 (—|${N}%);过门槛 (${N}),晋升 (${N})$`), (m) => `Research: ${m[1]} questions / ${m[2]} runs / ${m[3]} backtests / ${m[4]} improvement loops, completion ${m[5]}; ${m[6]} passed the gate, ${m[7]} promoted`],
  [new RegExp(`^复盘 (${N}) 批,教训提案 (${N}),已采纳 (${N})$`), (m) => `${m[1]} review batches, ${m[2]} lesson proposals, ${m[3]} adopted`],
  [new RegExp(`^(${N}) 笔结算,模型 (${N})R vs 机械 (${N})R$`), (m) => `${m[1]} settled, model ${m[2]}R vs mechanical ${m[3]}R`],
  [new RegExp(`^(${N}) 笔结算,可与机械对照比的只有 (${N}) 笔\\(< (${N})\\),不判色$`), (m) => `${m[1]} settled, only ${m[2]} comparable with the mechanical baseline (< ${m[3]}); not scored`],
  [new RegExp(`^账户 (${N})% vs BTC 持有 (${N})%(?:\\(剔除 (${N}) 次出入金跳变\\))?$`), (m) => `Account ${m[1]}% vs BTC buy-and-hold ${m[2]}%${m[3] ? ` (excluding ${m[3]} deposit/withdrawal jumps)` : ''}`],
  [new RegExp(`^巡检 (${N}) 次\\(成功 (${N})\\),收到 (${N}) 条\\(解析失败 (${N})\\),发出 (${N}) 条\\(送达 (${N})\\)$`), (m) => `${m[1]} checks (${m[2]} ok), ${m[3]} received (${m[4]} parse failures), ${m[5]} sent (${m[6]} delivered)`],
  [new RegExp(`^(${N}) 条告警\\(去重\\),high/critical (${N})(?:\\(([\\w/]+)\\))?,拦截 (${N})$`), (m) => `${m[1]} alerts (deduplicated), high/critical ${m[2]}${m[3] ? ` (${m[3]})` : ''}, ${m[4]} blocked`],
  [new RegExp(`^(${N}) 次判断\\((${N}) 次有动作,账本 (${N}) 行\\),还没结算$`), (m) => `${m[1]} judgments (${m[2]} with actions, ${m[3]} ledger rows), not settled yet`],
  [new RegExp(`^(${N}) 次判断,没有模型调用$`), (m) => `${m[1]} judgments, no model calls`],
];

const warned = new Set<string>();

function matchRules(rules: Rule[], s: string, tr: Tr): string | null {
  for (const [re, fn] of rules) {
    const m = re.exec(s);
    if (m) {
      const out = fn(m, tr);
      if (out !== null) return out;
    }
  }
  return null;
}

/** 按「;」「；」拆段,但不拆「…」里的新闻标题(标题里常带分号) */
function splitOutsideQuotes(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '「') depth++;
    else if (ch === '」' && depth > 0) depth--;
    if ((ch === ';' || ch === '；') && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 翻一段(或整句)。认不出返回 null。纯函数,不看当前语言。 */
function translate(text: string): string | null {
  const s = text.trim();
  if (!s) return text;
  if (!HAN.test(s)) return text;
  const whole = matchRules(WHOLE, s, translate) ?? matchRules(MATRIX_WHOLE, s, translate) ?? matchRules(SEGMENT, s, translate);
  if (whole !== null) return whole;
  // 网关用 ; 拼多条:逐段翻,全部认得才算命中
  const parts = splitOutsideQuotes(s);
  if (parts.length < 2) return null;
  const out: string[] = [];
  for (const p of parts) {
    const r = translate(p);
    if (r === null) return null;
    out.push(r);
  }
  return out.join('; ');
}

/** 纯函数版:返回英文;认不出返回 null(测试和覆盖率统计用) */
export function serverTextEn(text: string): string | null {
  return translate(text);
}

/**
 * 显示点用:en 下翻译后端中文,zh 原样。认不出原样显示并在 dev 下 warn 一次。
 * 空值原样返回,方便 `st(a.detail)` 直接写在 JSX 里。
 */
export function st<T extends string | null | undefined>(text: T): T {
  if (!text || getLang() !== 'en' || !HAN.test(text)) return text;
  const out = translate(text);
  if (out !== null) return out as T;
  if (import.meta.env?.DEV && !warned.has(text)) {
    warned.add(text);
    console.warn(`[server-text] 没认出的后端句式: ${JSON.stringify(text.slice(0, 120))}`);
  }
  return text;
}
