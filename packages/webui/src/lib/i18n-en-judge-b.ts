/**
 * 评审版英文补漏 B(2026-09-26):策略页票池 allocator、工作流表单(票池 / 议会 / 限价入场 / 实验室闭环)、
 * 策略成绩行、执行面板说明、旧版楼层本地名册与兜底桌牌。key = 界面中文原文,由 lib/i18n-en.ts 展开进 EN。
 */
export const JUDGE_B_EN: Record<string, string> = {
  // ── 策略页 · 票池 allocator(AllocatorCard)
  '本 regime 净期望': 'Net expectancy (this regime)',
  '净期望': 'Net expectancy',
  '样本外净期望': 'Out-of-sample net expectancy',
  'Lab 期望': 'Lab expectancy',
  '状态不够格': 'Status not eligible',
  '健康度降级': 'Health downgraded',
  '同族已占位': 'Family slot taken',
  '与已选重复': 'Overlaps a pick',
  '冷却中': 'Cooling down',
  '排名没进前几': 'Ranked too low',
  '票池交给代码每天决策了': 'The pool is now decided by code once a day',
  '票池改回只有人能改': 'The pool is back to human-only edits',
  '算完了,但这一轮没有落库(只是预览)': 'Done, but this run was not saved (preview only)',
  '票池换好了:{reason}': 'Pool updated: {reason}',
  '算完了,票池没有变化': 'Done — the pool is unchanged',
  '已回滚到上一票池': 'Rolled back to the previous pool',
  '票池没有变化': 'Pool unchanged',
  '只有人改票池;allocator 只算预览,不落库': 'Only humans edit the pool; the allocator computes a preview and saves nothing',
  '代码每天决策一次票池;模型永远改不了它': 'Code decides the pool once a day; a model can never change it',
  '自动': 'Auto',
  '按当前规则现在算一遍,并把结果落进票池': 'Run the current rules now and write the result into the pool',
  '现在算一遍': 'Run now',
  '一步换回上一票池(不受最短驻留 / 冷却约束)': 'Restore the previous pool in one step (ignores minimum stay / cooldown)',
  '没有可回滚的票池': 'No previous pool to roll back to',
  '回滚到上一票池': 'Roll back to previous pool',
  '上次决策': 'Last decision',
  '上次换人': 'Last change',
  '下次决策': 'Next decision',
  '等下一次日更': 'Waiting for the next daily run',
  '为什么在 / 不在票池({n})': 'Why in / out of the pool ({n})',
  '票池由代码每天排一次;模型没有任何一条路径能改它,人随时能回滚。':
    'Code ranks the pool once a day. No model has any path to change it, and a human can roll it back at any time.',
  '手动模式:票池只有人改,下面这一遍只是预览,不落库。': 'Manual mode: only humans edit the pool. The run below is a preview and is not saved.',
  '票池决策加载失败': 'Failed to load pool decisions',
  '没有可参选的策略。': 'No eligible strategies.',
  '现在算一遍票池': 'Recompute the pool now',
  '确认重算票池': 'Confirm pool recompute',
  '按当前 regime 与最近 30 天的净期望重排一遍,并把结果**落进**票池(不是预览)。换下去的策略这一轮不再参加议会表态。':
    'Re-ranks by the current regime and 30-day net expectancy, and **writes** the result into the pool (not a preview). Strategies swapped out stop voting in the council this round.',
  '预览': 'Preview',
  '票池不会变': 'The pool will not change',
  '确认回滚票池': 'Confirm pool rollback',
  '一步把票池换回上一次的样子。回滚不受最短驻留 3 天与冷却 1 天的约束,同样会写进台账。':
    'Restores the pool to its previous state in one step. Rollback ignores the 3-day minimum stay and 1-day cooldown, and is recorded in the ledger as well.',
  '回滚到': 'Roll back to',
  '空票池': 'Empty pool',
  '在池': 'In pool',
  '这一档是毛值(没扣手续费 / 滑点),不是净值': 'This tier is gross (before fees / slippage), not net',
  '毛值': 'Gross',
  '台账': 'Ledger',

  // ── 工作流表单:票池 / 议会 / 限价入场 / 策略库自动化
  '票池谁来改': 'Who edits the pool',
  '共识票数': 'Consensus votes',
  '议会模型': 'Council model',
  '实验室自动闭环': 'Lab autopilot',
  '策略假设生成': 'Strategy hypothesis generation',
  '自动 = 代码每天排一次票池': 'Auto = code ranks the pool once a day',
  '每天一次按 regime 与最近 30 天净期望重排票池,会换掉正在参加议会表态的策略;不花钱,人随时能在策略页回滚。':
    'Once a day, re-ranks the pool by regime and 30-day net expectancy, and may swap out strategies currently voting in the council. Free; a human can roll it back any time on the Strategies page.',
  '票池只有你能改;allocator 只在策略页算预览,不落库。': 'Only you edit the pool; the allocator only computes a preview on the Strategies page and saves nothing.',
  '去策略页 →': 'Go to Strategies →',
  '关 / 只参考 / 硬闸': 'Off / Advisory / Hard gate',
  '只参考': 'Advisory',
  '硬闸:不够票不开仓': 'Hard gate: no entry without enough votes',
  '「硬闸」会真的拦下开仓:票池里够不到共识票数,这一单就不开。这一项本身不花钱。':
    '"Hard gate" really blocks entries: if the pool does not reach the consensus vote count, the trade is not opened. This setting itself costs nothing.',
  '1–4 条策略同向才算有共识': 'Consensus needs 1–4 strategies agreeing on direction',
  '关 / 副脑 / 主脑': 'Off / Cheap brain / Main brain',
  '关(纯代码表态)': 'Off (code-only votes)',
  '票池里每条策略都由代码表态,一次模型都不调,不花钱。': 'Every strategy in the pool votes via code. No model calls, no cost.',
  '会花钱:每条策略一次模型调用 —— 一轮判断的调用数 = 票池条数。':
    'Costs money: one model call per strategy — calls per judgment round = number of strategies in the pool.',
  '随判断 / 优先限价挂回踩': 'Follow judgment / Prefer limit on pullback',
  '随判断(市价也行)': 'Follow judgment (market OK)',
  '优先限价挂回踩': 'Prefer limit on pullback',
  '不花钱,但会改成交方式:优先限价 = 少追高,代价是可能挂不上、错过这一波。':
    'Free, but changes how orders fill: preferring limits means less chasing, at the cost of possibly not filling and missing the move.',
  '自动写回成绩、自动提草稿、数据态自动晋升': 'Auto-writes results, drafts proposals, promotes data stages',
  '零模型,不花钱;但会动策略状态(draft / backtest / shadow 这几格的数据态晋升)。进 paper 之后照样要人点。':
    'No model calls, free — but it does change strategy status (data-driven promotion across draft / backtest / shadow). Moving into paper still needs a human click.',
  '默认关': 'Off by default',
  '会花钱(副脑,每周 ≤ 1 次),而且会往策略库里加新草稿。新草稿不会自己进票池,要一格一格晋升。':
    'Costs money (cheap brain, at most once a week) and adds new drafts to the strategy library. New drafts never enter the pool on their own; they must be promoted stage by stage.',

  // ── 策略页 · 成绩行
  '有效 n': 'Valid n',
  '独立代码策略执行器:使用策略入场、止损、止盈、持有期与成本结算；模型回放另见评测':
    'Standalone code executor: settles with the strategy’s entry, stop loss, take profit, holding period and costs. Model replays are under Eval.',
  '完整策略成绩': 'Full strategy results',
  '固定方向代理，不用于完整策略晋升': 'Fixed-direction proxy; not used for full-strategy promotion',
  '代码方向代理成绩': 'Code direction-proxy results',

  // ── 执行面板
  'okx = 网关直接调官方 okx CLI 下单(本地签名,key 只留在本机,不经过任何模型);开仓和止损是一次原子请求;纸面不花钱':
    'okx = the gateway calls the official okx CLI for every order (signed locally, keys never leave this machine, no model in the path). Entry and stop loss go out as one atomic request. Paper is free.',

  // ── 旧版楼层:兜底桌牌 + 本地名册(网关没给 /api/bots 时用;网关名册文案同源)
  '{role} 台': '{role} desk',
  'Gate Captain / 总协调': 'Gate Captain / Coordinator',
  '用户目标、任务路由、结果汇总、待办与审批收件箱': 'User goals, task routing, result summaries, to-dos and the approval inbox',
  '用户偏好、沟通方式、团队运行摘要': 'User preferences, communication style, team run summaries',
  '不能批准自己的提案,不能直接触达交易所': 'Cannot approve its own proposals or reach the exchange directly',
  '占位:dispatcher / mission timeline 还没实现。今天的对话 Agent(chat.ts)只承担了它的一部分。':
    'Placeholder: the dispatcher / mission timeline is not built yet. Today the chat agent (chat.ts) covers only part of this role.',
  'Radar / 信息与发现': 'Radar / Intel & discovery',
  '市场状态、新闻、候选与 MonitorSpec;每 12 小时短线筛选,每 3 天 / 每周中长线筛选':
    'Market state, news, candidates and MonitorSpec; short-term screen every 12 hours, medium/long-term screen every 3 days / weekly',
  '信息源质量、候选表现、摘要偏好': 'Source quality, candidate performance, summary preferences',
  '只读,不生成订单;watchlist 提案默认要人点「应用」': 'Read-only, never creates orders; watchlist proposals need a human to click "Apply" by default',
  'Thread Manager / 交易论点': 'Thread Manager / Trade thesis',
  '一个 StrategyThread 从 setup 到关闭的论点连续性': 'Thesis continuity of a StrategyThread from setup to close',
  '按 symbol/strategy/thread 隔离的教训': 'Lessons isolated by symbol / strategy / thread',
  '只提议;数量、杠杆和是否允许由代码决定': 'Proposes only; size, leverage and whether it is allowed are decided by code',
  'Strategy Lab / 研究与优化': 'Strategy Lab / Research & optimization',
  'StrategySpec、实验假设、回测任务和晋升提案': 'StrategySpec, experiment hypotheses, backtest jobs and promotion proposals',
  '研究日志、失败假设、实验结果;不读取 Live 凭证': 'Research log, failed hypotheses, experiment results; never reads live credentials',
  '只能进入 DRAFT/BACKTEST/PAPER,晋升必须人批': 'Can only reach DRAFT / BACKTEST / PAPER; promotion needs human approval',
  '占位:策略库与回测已经有了(strategies.ts / backtest.ts),但还没有会自己派实验的 worker 池。':
    'Placeholder: the strategy library and backtests exist (strategies.ts / backtest.ts), but there is no worker pool that dispatches experiments on its own yet.',
  'Portfolio Manager / 组合经理': 'Portfolio Manager',
  '总/净/簇敞口、风险预算、资金分配和组合计划': 'Gross / net / cluster exposure, risk budget, capital allocation and portfolio plans',
  '组合目标与用户偏好;当前仓位永远现拉': 'Portfolio goals and user preferences; current positions are always fetched live',
  '输出 PortfolioPlan,不直接生成交易所效果': 'Outputs a PortfolioPlan; never acts on the exchange directly',
  '占位:确定性 exposure engine 与 portfolio_snapshots 还没做(notebook Phase 3)。':
    'Placeholder: the deterministic exposure engine and portfolio_snapshots are not built yet (notebook Phase 3).',
  'Risk Sentinel / 风控哨兵': 'Risk Sentinel',
  '实时不变量、gate verdict、incident 与告警': 'Live invariants, gate verdicts, incidents and alerts',
  '告警去重与解释模板;实时指标不进长期记忆': 'Alert dedup and explanation templates; live metrics never enter long-term memory',
  '代码可以拒绝/收紧,模型永远不能放宽': 'Code can reject / tighten; a model can never loosen',
  '占位:gates.ts 已经是它的心脏,但 alert fingerprint / incident 生命周期还没做(Phase 3)。':
    'Placeholder: gates.ts is already its core, but alert fingerprints / the incident lifecycle are not built yet (Phase 3).',
  'Reviewer / 评测与复盘': 'Reviewer / Eval & review',
  '反方审查、交易复盘、memory/skill/strategy 候选': 'Devil’s-advocate review, trade reviews, memory / skill / strategy candidates',
  '经批准的 lesson 与评测结论': 'Approved lessons and eval conclusions',
  '不能改活跃策略或风险参数,只能提出 diff': 'Cannot change active strategies or risk parameters; can only propose a diff',
  '占位:复盘(memory.ts runReflect)与归因(attribution.ts)已经在跑,但还不是一个会被 fan-out 叫醒的角色。':
    'Placeholder: review (memory.ts runReflect) and attribution (attribution.ts) already run, but it is not yet a role that fan-out can wake up.',
  'ASP Agent / 信号市场': 'ASP Agent / Signal market',
  'OKX.AI 入站、发布、身份、领款与售后': 'OKX.AI inbound, publishing, identity, payouts and after-sales',
  '市场账本与订阅配置': 'Market ledger and subscription settings',
  '不直连交易所,不转发外部信号;售后由人决策': 'No direct exchange access, never relays external signals; after-sales is decided by a human',
  '代码驱动;本批零模型调用': 'Code-driven; zero model calls in this batch',
  'Executor / 执行服务': 'Executor / Execution service',
  '消费已授权 plan、下单、保护腿、回执与对账': 'Consumes authorized plans: orders, protection legs, receipts and reconciliation',
  '无自由文本记忆;只保存六记录、checkpoint 和回执': 'No free-text memory; stores only the six records, checkpoints and receipts',
  '只接受 plan_hash/account_version/authorization 完整的结构化请求':
    'Accepts only structured requests with a complete plan_hash / account_version / authorization',
};
