/**
 * Agent 页纯逻辑(2026-09-25 改版):意图一句话、执行通道判定、建议提问、工具调用 → 中文动作、「今天」小结。
 * 全部无 React、无网络,单测在 test/agent-page.test.ts。
 */
import { t } from '@/lib/i18n';

// ---------------------------------------------------------------- 执行通道

export type ChannelKind = 'sim' | 'live' | 'unknown';

interface ChannelInput {
  backend?: string | null;
  exchange?: 'okx' | 'binance';
  okx?: { available?: boolean; demo?: boolean | null } | null;
}

/** 单子最终下到哪:模拟(纸面 / 模拟盘)还是实盘。okx 看 profile 的 demo;币安 demo 后端是模拟盘,其余直连通道按实盘算。 */
export function channelOf(view: ChannelInput | null | undefined): { kind: ChannelKind; label: string } {
  if (!view || !view.backend) return { kind: 'unknown', label: t('执行通道未知') };
  if (view.backend === 'paper') return { kind: 'sim', label: t('纸面模拟') };
  if (view.backend === 'demo') return { kind: 'sim', label: t('币安模拟盘') };
  if (view.exchange === 'okx' || view.backend === 'okx') {
    if (!view.okx?.available) return { kind: 'unknown', label: t('OKX 未接通') };
    if (view.okx.demo === false) return { kind: 'live', label: t('OKX 实盘') };
    if (view.okx.demo === true) return { kind: 'sim', label: t('OKX 模拟盘') };
    return { kind: 'unknown', label: t('OKX(盘别未知)') };
  }
  return { kind: 'live', label: t('币安实盘') };
}

// ---------------------------------------------------------------- 意图一句话

export interface IntentInput {
  halted: boolean;
  paused: boolean;
  capped: boolean;
  strategy: { kind: 'free' | 'strategy'; name?: string | null; version?: number | null; run_status?: string | null; mode?: string | null } | null | undefined;
  watchCount: number;
  timeframe: string | null | undefined;
  /** 距下一轮扫描的毫秒数;null = 不知道 */
  nextInMs: number | null;
  channel: { kind: ChannelKind; label: string };
}

export type IntentTone = 'danger' | 'warn' | 'ok' | 'idle';

export interface Intent {
  tone: IntentTone;
  /** 大标题:agent 此刻在干什么 */
  title: string;
  /** 一句话说清楚它会怎么做 */
  sentence: string;
}

export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function modeText(mode: string | null | undefined): string {
  if (mode === 'auto') return t('信号到了直接下单');
  if (mode === 'jev') return t('Jev 判断后下单');
  if (mode === 'confirm') return t('每笔等你确认'); // 已下线,只给老运行
  if (mode === 'signal_only') return t('只出信号不下单');
  return t('LLM 判断后下单');
}

function strategyLabel(s: NonNullable<IntentInput['strategy']>): string {
  const name = s.name || t('未命名策略');
  return s.version ? `${name} v${s.version}` : name;
}

export function intentOf(i: IntentInput): Intent {
  const watch = t('盯 {n} 个币', { n: i.watchCount }) + (i.timeframe ? `(${i.timeframe})` : '');
  const where = i.channel.kind === 'unknown' ? i.channel.label : t('单子下到{ch}', { ch: i.channel.label });
  const next = i.nextInMs !== null ? t('下一次扫描 {t} 后', { t: fmtCountdown(i.nextInMs) }) : null;
  const tail = [watch, next, where].filter(Boolean).join(t(','));

  if (i.halted) return { tone: 'danger', title: t('紧急停止中'), sentence: t('任何新开仓都会被拒;解除要去「风控与自动化」。') };
  if (i.paused) return { tone: 'warn', title: t('已暂停'), sentence: t('到点不调模型、不开新仓;{watch},点「恢复」继续。', { watch }) };
  if (i.capped) return { tone: 'warn', title: t('今天的判断额度用完了'), sentence: t('明天之前不再调模型;{watch}。上限在「风控与自动化」里调。', { watch }) };

  const s = i.strategy;
  if (s?.kind === 'strategy') {
    const label = strategyLabel(s);
    if (s.run_status && s.run_status !== 'running') {
      return { tone: 'warn', title: t('策略「{name}」没在运行', { name: label }), sentence: t('运行状态是 {st},不会按它开新仓;{tail}。', { st: s.run_status, tail }) };
    }
    return { tone: 'ok', title: t('按策略「{name}」运行', { name: label }), sentence: t('只按这条策略的规则开仓,{mode};{tail}。', { mode: modeText(s.mode), tail }) };
  }
  if (!s) return { tone: 'idle', title: t('读取中…'), sentence: tail ? `${tail}。` : '' };
  return { tone: 'ok', title: t('自由判断中'), sentence: t('模型按 playbook 在观察列表里找机会,开仓前过代码闸;{tail}。', { tail }) };
}

// ---------------------------------------------------------------- 建议提问

export type PromptIcon = 'recommend' | 'research' | 'switch' | 'why' | 'review';

export interface SuggestedPrompt {
  id: PromptIcon;
  /** 卡片标题(短) */
  title: string;
  /** 点一下填进输入框的原话 */
  text: string;
  /** 卡片副标题:它会做什么 */
  hint: string;
}

function baseSymbol(sym: string): string {
  return sym.replace(/[-_]?(USDT|USDC|USD)(-SWAP)?$/i, '').toUpperCase();
}

/** 按「策略研究」流程排的五个建议提问;研究的币优先 SOL(在观察列表里或列表为空),否则取观察列表第一个非 BTC。 */
export function suggestedPrompts(opts: { watchlist?: string[] | null; strategy?: { kind: 'free' | 'strategy'; name?: string | null } | null }): SuggestedPrompt[] {
  const list = (opts.watchlist ?? []).map(baseSymbol).filter(Boolean);
  const sym = !list.length || list.includes('SOL') ? 'SOL' : (list.find((s) => s !== 'BTC') ?? list[0]);
  const running = opts.strategy?.kind === 'strategy';
  return [
    { id: 'recommend', title: t('推荐几个币'), text: t('推荐几个币,短中长线分别适合什么'), hint: t('出资产 × 周期推荐卡') },
    { id: 'research', title: t('研究 {sym} 4h', { sym }), text: t('帮我研究 {sym} 4h 适合什么策略', { sym }), hint: t('开海选,跑完回报') },
    running
      ? { id: 'switch', title: t('换一条策略'), text: t('当前策略「{name}」最近表现怎么样?要不要换一条跑', { name: opts.strategy?.name ?? '' }), hint: t('对比后再切,实盘要你输 LIVE') }
      : { id: 'switch', title: t('切到某条策略跑'), text: t('我的策略里哪条适合现在跑?帮我切过去'), hint: t('从「我的策略」挑一条设为当前') },
    { id: 'why', title: t('今天为什么没开仓'), text: t('今天为什么没开仓?'), hint: t('先翻判断记录再回答') },
    { id: 'review', title: t('复盘最近的交易'), text: t('复盘最近的交易'), hint: t('读交易历史与复盘卡') },
  ];
}

// ---------------------------------------------------------------- 工具调用 → 做了什么

export type ToolGroup = 'read' | 'research' | 'act' | 'config';

const TOOL_VERB: Record<string, { zh: string; group: ToolGroup }> = {
  get_state: { zh: '读取账户与行情', group: 'read' },
  list_threads: { zh: '查看交易线程', group: 'read' },
  get_thread: { zh: '查看一条线程', group: 'read' },
  get_episode: { zh: '翻判断记录', group: 'read' },
  list_history: { zh: '读取交易历史', group: 'read' },
  propose_thread: { zh: '提议开仓', group: 'act' },
  close_thread: { zh: '提议平仓', group: 'act' },
  set_workflow: { zh: '修改盯盘设置', group: 'config' },
  run_scan: { zh: '立即扫描', group: 'act' },
  run_info: { zh: '跑一次信息员', group: 'act' },
  run_review: { zh: '复查线程', group: 'act' },
  remember: { zh: '记住一条偏好', group: 'config' },
  recall: { zh: '查长期记忆', group: 'read' },
  forget_memory: { zh: '删除一条记忆', group: 'config' },
  get_team: { zh: '查看团队状态', group: 'read' },
  get_portfolio: { zh: '查看账户敞口', group: 'read' },
  get_risk_alerts: { zh: '查看风控告警', group: 'read' },
  get_screen: { zh: '查看筛选结果', group: 'read' },
  get_brief: { zh: '读值班简报', group: 'read' },
  get_reviewer_cards: { zh: '读复盘卡', group: 'read' },
  run_screen: { zh: '让 Radar 筛一轮', group: 'act' },
  run_review_batch: { zh: '批量复盘', group: 'act' },
  run_experiment: { zh: '跑一轮策略实验', group: 'research' },
  ack_handoff: { zh: '标记交接已读', group: 'config' },
  list_intents: { zh: '查看待批下单', group: 'read' },
  approve_intent: { zh: '批准下单', group: 'act' },
  reject_intent: { zh: '否决下单', group: 'act' },
  request_execution: { zh: '推送确认卡', group: 'act' },
  recommend_assets: { zh: '推荐资产与周期', group: 'research' },
  // 09-25 批量验证并进「策略研究」流程页,对用户叫「海选」;toolHref 给出对应步骤的深链
  start_matrix_study: { zh: '开始海选', group: 'research' },
  get_matrix_study: { zh: '查看海选进度', group: 'research' },
  adopt_matrix_finalist: { zh: '把候选存成我的策略', group: 'research' },
  get_agent_strategy: { zh: '查看当前策略', group: 'read' },
  set_agent_strategy: { zh: '切换当前策略', group: 'config' },
  get_judgment_ledger: { zh: '读判断账本', group: 'read' },
  list_candidates: { zh: '查看影子候选', group: 'read' },
  list_my_strategies: { zh: '查看我的策略', group: 'read' },
  get_backtest_report: { zh: '读回测报告', group: 'research' },
  get_evolution: { zh: '查看进化方格', group: 'read' },
  get_universe_scan: { zh: '读全市场扫描', group: 'read' },
  // §9.55 ASP Agent 只读工具
  get_asp_overview: { zh: '读 ASP 总览', group: 'read' },
  list_asp_services: { zh: '看上架的服务', group: 'read' },
  list_asp_tasks: { zh: '看接单与交付', group: 'read' },
  list_asp_subscribers: { zh: '看订阅者', group: 'read' },
  list_market_inbox: { zh: '看信号收件箱', group: 'read' },
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function short(list: string[], max = 4): string {
  return list.length > max ? `${list.slice(0, max).join(' ')} +${list.length - max}` : list.join(' ');
}

/** 从参数里挑一句最有信息量的补充(币、周期、id、改了哪些字段)。 */
function toolDetail(name: string, rawArgs: unknown): string | null {
  const a = asRecord(rawArgs);
  if (name === 'set_workflow') {
    const keys = Object.keys(asRecord(a.patch));
    return keys.length ? short(keys, 3) : null;
  }
  if (name === 'set_agent_strategy') {
    if (a.kind === 'free') return t('回到自由判断');
    return str(a.strategy_id) ? `${a.strategy_id}${a.version ? ` v${a.version}` : ''}` : null;
  }
  if (name === 'propose_thread') {
    const sym = str(a.symbol);
    const side = a.side === 'long' ? t('做多') : a.side === 'short' ? t('做空') : null;
    return [sym, side].filter(Boolean).join(' ') || null;
  }
  const parts: string[] = [];
  const syms = Array.isArray(a.symbols) ? a.symbols.filter((s): s is string => typeof s === 'string') : [];
  if (syms.length) parts.push(short(syms.map(baseSymbol)));
  else if (str(a.symbol)) parts.push(str(a.symbol)!);
  const tfs = Array.isArray(a.timeframes) ? a.timeframes.filter((s): s is string => typeof s === 'string') : [];
  if (tfs.length) parts.push(tfs.join('/'));
  if (str(a.horizon)) parts.push(str(a.horizon)!);
  if (!parts.length) {
    const id = str(a.id) ?? str(a.study_id) ?? str(a.strategy_id) ?? str(a.recommendation_id);
    if (id) parts.push(id.length > 18 ? `${id.slice(0, 16)}…` : id);
    else if (str(a.query)) parts.push(`「${str(a.query)}」`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export interface ToolAction {
  verb: string;
  detail: string | null;
  group: ToolGroup;
  ok: boolean;
  /** 原始工具名(展开时显示,方便对照日志) */
  raw: string;
  /** 研究类工具对应的「策略研究」流程页步骤深链(推荐 → 选资产,海选 → 海选详情,存成策略 → 验收);没有就 null */
  href: string | null;
}

/**
 * 研究类工具 → #strategy-research 的对应步骤(09-25 批量验证 / 研究台并进流程页)。
 * 只读参数和结果里现成的 id,拿不到就不给链接(不猜)。
 */
export function toolHref(name: string, rawArgs: unknown, rawResult?: unknown): string | null {
  const a = asRecord(rawArgs), r = asRecord(rawResult);
  const q = (step: string, k: string, v: string | null) => (v ? `#strategy-research?step=${step}&${k}=${encodeURIComponent(v)}` : null);
  if (name === 'recommend_assets') return q('assets', 'rec', str(r.recommendation_id) ?? str(r.id));
  if (name === 'start_matrix_study' || name === 'get_matrix_study') return q('scout', 'study', str(r.id) ?? str(r.study_id) ?? str(a.id) ?? str(a.study_id));
  if (name === 'adopt_matrix_finalist') return q('validate', 'strategy', str(r.strategy_id) ?? str(a.strategy_id));
  return null;
}

export function toolAction(call: { name: string; args: unknown; ok: boolean; result?: unknown }): ToolAction {
  const known = TOOL_VERB[call.name];
  return {
    verb: known ? t(known.zh) : call.name,
    detail: toolDetail(call.name, call.args),
    group: known?.group ?? 'read',
    ok: call.ok,
    raw: call.name,
    href: call.ok ? toolHref(call.name, call.args, call.result) : null,
  };
}

// ---------------------------------------------------------------- 今天

interface ThreadLike {
  id: string;
  status: string;
  opened_at: number | null;
  closed_at: number | null;
}

export interface TodaySummary {
  opened: number;
  closed: number;
  /** 今天平掉且已结算的已实现盈亏;没有平仓时 null */
  realized: number | null;
  /** 今天平掉但还没结算完的笔数(盈亏不能当 0 看) */
  unsettled: number;
  holding: number;
  pendingEntry: number;
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function todaySummary(opts: {
  now: number;
  dayStart?: number;
  openThreads: ThreadLike[];
  historyThreads: (ThreadLike & { pnl_num?: number; settled?: boolean })[] | null | undefined;
}): TodaySummary {
  const start = opts.dayStart ?? startOfDay(opts.now);
  const openedIds = new Set<string>();
  for (const th of [...opts.openThreads, ...(opts.historyThreads ?? [])]) if (th.opened_at != null && th.opened_at >= start) openedIds.add(th.id);
  let closed = 0;
  let unsettled = 0;
  let realized: number | null = null;
  for (const th of opts.historyThreads ?? []) {
    if (th.closed_at == null || th.closed_at < start) continue;
    // 撤掉的挂单(从没成交)不算平仓
    if (th.status === 'canceled' && th.opened_at == null) continue;
    closed += 1;
    if (th.settled === false || typeof th.pnl_num !== 'number' || Number.isNaN(th.pnl_num)) unsettled += 1;
    else realized = (realized ?? 0) + th.pnl_num;
  }
  return {
    opened: openedIds.size,
    closed,
    realized,
    unsettled,
    holding: opts.openThreads.filter((th) => th.status === 'in_position').length,
    pendingEntry: opts.openThreads.filter((th) => th.status === 'pending_entry').length,
  };
}
