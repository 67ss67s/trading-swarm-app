/**
 * 楼层 v4:真实数据 → 引擎快照(纯函数,无 React / 无 DOM,test/floor-v4.test.ts 覆盖)。
 *
 * 口径(docs/design/floor-v4-2026-09-25.md §1):
 *   - agents   = /api/bots 名册 + presence(网关缺 presence 时用旧楼层同一套 derivePresence 兜底)
 *   - handoffs = 真 bot_handoffs(source=handoff)+ activity 里能落到「角色 → 角色」的行(source=activity,
 *                同旧楼层 presence.ts 的 ROUTES;右栏动态流里分开打标签,不冒充 bot 在对话)
 *   - inbox    = pending_approval 意图(待批订单)+ 待阅的真交接
 *   - money    = 执行通道账户权益 / 今日盈亏(权益曲线今日起点 → 现在;没曲线时退回 overview.daily_loss_pct)/ 持仓数
 *   - evolution= /api/evolution/daily 的真方格(EvoRoleRow)
 *   - meetings = 同一线程 / 判断在 3 分钟内牵动 ≥3 个角色的 activity 链(真数据推出来的「开会」)
 * 布局 B 直接吃 FloorModel(与 engine-b Snapshot 同形);布局 A 走 toSnapshotA 适配。
 */
import type { ActivityItem, BotHandoff, BotsResponse, DemoIntent, ExecutionView, HistoryResponse, Kline, Overview, PortfolioSnapshotResponse, RiskAlertsResponse } from '@/api/types';
import type { EvoDailyResponse } from '@/api/evolution';
import type { ResearchStrategy } from '@trading-swarm/contracts';
import { activityToFeed, derivePresence } from '@/components/floor/presence';
import { LOCAL_ROSTER } from '@/components/floor/roles';
import type { BotPresence, BotProfileWithPresence, PresenceState } from '@/components/floor/types';
import { t } from '@/lib/i18n';
import type { Deco } from './deco';
import type { FloorSnapshot as SnapshotA, TaskIcon } from './engine-a/types';
import { ROLES, ROLE_ORDER } from './engine-b/roles';
import type { ActivityItem as EngineActivity, AgentSnap, AgentStat, AgentStatus, EvoRoleRow, HandoffSnap, InboxItem, MarketState, MeetingSnap, Role, Snapshot, StrategyCard } from './engine-b/types';

export type { Role };

export interface FloorTask {
  id: string;
  label: string;
}

export interface FloorInputs {
  now: number;
  bots?: BotsResponse | null;
  activity?: readonly ActivityItem[] | null;
  overview?: Overview | null;
  execution?: ExecutionView | null;
  portfolio?: PortfolioSnapshotResponse | null;
  risk?: RiskAlertsResponse | null;
  evolution?: EvoDailyResponse | null;
  intents?: readonly DemoIntent[] | null;
  strategies?: readonly ResearchStrategy[] | null;
  /** 有活跃 Strategy Run 的策略 id(当前策略优先挑它) */
  runningStrategyIds?: ReadonlySet<string>;
  history?: HistoryResponse | null;
  /** BTC 最近 60 根 1m K 线(天气 = 1 小时波动) */
  btcKlines?: readonly Kline[] | null;
  /** 你从楼层派出去、还没完成的活 */
  tasks?: Partial<Record<Role, FloorTask>>;
}

/** 右栏「团队动态」一行(与画布同源) */
export interface FeedRow {
  key: string;
  at: number;
  from: Role | 'user';
  to: Role | 'user' | null;
  text: string;
  source: 'handoff' | 'activity';
  /** 真交接的状态;activity 行为 null */
  status: string | null;
  tone: 'plain' | 'ok' | 'warn' | 'bad';
}

export interface FloorModel extends Snapshot {
  halted: boolean;
  paused: boolean;
  feed: FeedRow[];
  /** 待批意图原件(审批卡用) */
  pendingIntents: DemoIntent[];
  /** 待阅真交接原件(收件箱点「已阅」用) */
  pendingHandoffs: BotHandoff[];
  /** 当前策略原件(拖给 EXEC → RunDialog) */
  strategyObj: ResearchStrategy | null;
  /** 房间装饰数字(跑马灯 / 敞口),见 deco.ts */
  deco: Deco;
}

const KNOWN = new Set<string>(ROLE_ORDER);
export const isRole = (r: string | null | undefined): r is Role => !!r && KNOWN.has(r);

const DAY = 86_400_000;
const base = (sym: string) => sym.replace(/USDT$/, '');

/** 房间装饰数字:持仓(按未实现盈亏着色)+ 观察币最新价 + 最近一笔成交;敞口来自组合快照 */
export function buildDeco(inp: Pick<FloorInputs, 'overview' | 'portfolio' | 'activity'>): Deco {
  const ov = inp.overview;
  const tape: Deco['tape'] = [];
  for (const p of (ov?.account?.positions ?? []).slice(0, 4)) {
    const u = Number(p.unrealized_pnl) || 0;
    tape.push({ text: `POS ${base(p.symbol)} ${p.side === 'long' ? 'LONG' : 'SHORT'} ${u >= 0 ? '+' : ''}${u.toFixed(1)}`, tone: u >= 0 ? 'up' : 'down' });
  }
  const fill = (inp.activity ?? []).find((a) => a.kind === 'entry_filled' && a.symbol);
  if (fill?.symbol) tape.push({ text: `FILL ${base(fill.symbol)}`, tone: 'hi' });
  const markets = ov?.markets ?? {};
  for (const sym of (ov?.workflow?.watchlist ?? []).slice(0, 5)) {
    const last = markets[sym]?.last;
    if (last) tape.push({ text: `${base(sym)} ${Number(last) >= 1000 ? Number(last).toFixed(0) : last}`, tone: 'hi' });
  }
  const snap = inp.portfolio?.snapshot;
  const eq = snap?.equity ?? 0;
  const exposurePct = snap?.positions.gross_ratio != null ? `${Math.round(snap.positions.gross_ratio * 100)}%` : null;
  const byCoin: [string, number][] = snap && eq > 0
    ? Object.entries(snap.by_symbol).map(([k, g]) => [base(k).slice(0, 5), Math.min(1, g.gross / eq)] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 5)
    : [];
  const num = (v: string) => {
    const x = Number(v);
    return Number.isFinite(x) ? (Math.abs(x) >= 1000 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(3)) : v;
  };
  const ledger = (ov?.account?.positions ?? []).slice(0, 9).map((p) => {
    const u = Number(p.unrealized_pnl) || 0;
    return [base(p.symbol).slice(0, 7), p.side === 'long' ? 'LONG' : 'SHORT', num(p.qty), num(p.entry_price), num(p.mark_price), `${u >= 0 ? '+' : ''}${u.toFixed(2)}`];
  });
  return { tape, exposurePct, byCoin, ledger };
}
const HANDOFF_WINDOW = 24 * 3600_000;

export function presenceToStatus(s: PresenceState | undefined): AgentStatus {
  switch (s) {
    case 'thinking':
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'blocked':
      return 'stuck';
    default:
      return 'idle';
  }
}

function n(v: unknown): number | null {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
}
function fmt2(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function clip(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 今日盈亏:权益曲线里今天 UTC 0 点之前最后一个点(没有就今天第一个点)→ 当前权益 */
export function pnlToday(inp: Pick<FloorInputs, 'now' | 'overview' | 'history'>): string {
  const eqNow = n(inp.overview?.account?.equity);
  const curve = inp.history?.equity ?? [];
  const backend = inp.overview?.account?.backend;
  const pts = backend ? curve.filter((p) => !p.backend || p.backend === backend) : curve;
  const dayStart = Math.floor(inp.now / DAY) * DAY;
  if (eqNow != null && pts.length) {
    let base: number | null = null;
    for (const p of pts) {
      if (p.at < dayStart) base = p.equity;
      else {
        if (base == null) base = p.equity;
        break;
      }
    }
    if (base != null && base > 0) return (eqNow - base).toFixed(2);
  }
  // 兜底:网关的日亏损百分比(正 = 亏)
  const dl = n((inp.overview as { daily_loss_pct?: string } | null | undefined)?.daily_loss_pct);
  if (eqNow != null && dl != null) return (-(eqNow * dl) / 100).toFixed(2);
  return '0';
}

/** BTC 1 小时波动 = 最近 60 根 1m 的 (最高 − 最低) / 开盘 */
export function btcVol1h(kl: readonly Kline[] | null | undefined): string {
  if (!kl || kl.length < 2) return '0';
  const open = n(kl[0]!.open);
  let hi = -Infinity, lo = Infinity;
  for (const k of kl) {
    const h = n(k.high), l = n(k.low);
    if (h != null && h > hi) hi = h;
    if (l != null && l < lo) lo = l;
  }
  if (!open || !Number.isFinite(hi) || !Number.isFinite(lo)) return '0';
  return (((hi - lo) / open) * 100).toFixed(2);
}

export function riskToWeather(level: string | null | undefined): MarketState['risk_level'] {
  return level === 'high' || level === 'critical' ? 'high' : level === 'warn' ? 'mid' : 'low';
}

const STAGE: Record<string, StrategyCard['stage']> = { draft: 'draft', backtested: 'backtest', paper: 'paper', live: 'live', published: 'live' };

/** 当前策略:有活跃运行的 > live/published > paper > 最近更新;归档的不算 */
export function pickStrategy(list: readonly ResearchStrategy[] | null | undefined, running?: ReadonlySet<string>): ResearchStrategy | null {
  const live = (list ?? []).filter((s) => s.status !== 'archived');
  if (!live.length) return null;
  const rank = (s: ResearchStrategy) => (running?.has(s.id) ? 4 : s.status === 'live' || s.status === 'published' ? 3 : s.status === 'paper' ? 2 : s.status === 'backtested' ? 1 : 0);
  return [...live].sort((a, b) => rank(b) - rank(a) || b.updated_at - a.updated_at)[0] ?? null;
}

function profilesOf(inp: FloorInputs): BotProfileWithPresence[] {
  const src = (inp.bots?.bots as BotProfileWithPresence[] | undefined) ?? LOCAL_ROSTER;
  return src.filter((p) => isRole(p.role));
}

function roleStats(role: Role, inp: FloorInputs, pendingIntents: number, pendingHandoffs: number): AgentStat[] {
  const ov = inp.overview;
  const usage = ov?.usage_today;
  const runsToday = (inp.bots?.runs ?? []).filter((r) => r.role === role && r.started_at >= Math.floor(inp.now / DAY) * DAY);
  const generic: AgentStat[] = [
    { label: t('今日运行'), value: String(runsToday.length) },
    { label: t('今日花费'), value: `¥${runsToday.reduce((s, r) => s + (r.cost_cny || 0), 0).toFixed(2)}` },
    { label: t('失败'), value: String(runsToday.filter((r) => r.status === 'failed' || Boolean(r.error)).length) },
  ];
  switch (role) {
    case 'gate_captain':
      return [
        { label: t('待批订单'), value: String(pendingIntents) },
        { label: t('待阅交接'), value: String(pendingHandoffs) },
        { label: t('今日判断'), value: usage ? `${usage.judgments}/${usage.cap || '∞'}` : '—' },
      ];
    case 'radar': {
      const ms = ov?.market_state;
      return [
        { label: t('观察币'), value: String(ov?.workflow?.watchlist?.length ?? 0) },
        { label: t('候选'), value: ms ? String(ms.candidates.length) : '—' },
        { label: t('风险事件'), value: ms ? String(ms.risk_events.length) : '—' },
      ];
    }
    case 'thread_manager':
      return [
        { label: t('开着的线程'), value: String(ov?.threads?.length ?? 0) },
        { label: t('排队判断'), value: String(ov?.queue?.pending ?? 0) },
        { label: t('今日判断'), value: usage ? String(usage.judgments) : '—' },
      ];
    case 'strategy_lab': {
      const list = (inp.strategies ?? []).filter((s) => s.status !== 'archived');
      const sharpes = list.map((s) => s.summary?.sharpe).filter((x): x is number => typeof x === 'number');
      return [
        { label: t('我的策略'), value: String(list.length) },
        { label: t('已回测'), value: String(list.filter((s) => s.summary?.report_id).length) },
        { label: t('最佳 Sharpe'), value: sharpes.length ? Math.max(...sharpes).toFixed(2) : '—' },
      ];
    }
    case 'portfolio_manager': {
      const snap = inp.portfolio?.snapshot;
      const eq = snap?.equity ?? 0;
      return [
        { label: t('总敞口'), value: snap?.positions.gross_ratio != null ? `${snap.positions.gross_ratio.toFixed(2)}×` : '—' },
        { label: t('净敞口'), value: snap && eq > 0 ? `${((snap.positions.net / eq) * 100).toFixed(0)}%` : '—' },
        { label: t('风险簇'), value: snap ? String(Object.keys(snap.by_cluster).length) : '—' },
      ];
    }
    case 'risk_sentinel': {
      const dl = n((ov as { daily_loss_pct?: string } | null | undefined)?.daily_loss_pct);
      return [
        { label: t('风控等级'), value: inp.risk ? inp.risk.level : '—' },
        { label: t('开着的告警'), value: inp.risk ? String(inp.risk.alerts.length) : '—' },
        { label: t('今日亏损'), value: dl != null ? `${dl.toFixed(2)}%/${ov?.workflow?.daily_loss_stop_pct ?? '—'}%` : '—' },
      ];
    }
    case 'executor': {
      const acct = ov?.account;
      const upnl = n(acct?.unrealized_pnl);
      return [
        { label: t('持仓'), value: acct ? String(acct.positions.length) : '—' },
        { label: t('挂单'), value: acct ? String(acct.open_orders.length) : '—' },
        { label: t('未实现'), value: upnl != null ? `${upnl >= 0 ? '+' : ''}${fmt2(upnl)}` : '—' },
      ];
    }
    case 'reviewer': {
      const st = inp.history?.stats;
      return st
        ? [
            { label: t('已结算'), value: String(st.count) },
            { label: t('胜率'), value: `${Math.round(st.win_rate * 100)}%` },
            { label: t('累计盈亏'), value: fmt2(Number(st.total_pnl) || 0) },
          ]
        : generic;
    }
    default:
      return generic;
  }
}

const TONE: Partial<Record<string, FeedRow['tone']>> = {
  approved: 'ok', entry_filled: 'ok', tp_hit: 'ok', protection_placed: 'ok', risk_cleared: 'ok', attention_cleared: 'ok', screen_done: 'ok',
  approval_needed: 'warn', proposal: 'warn', cap_reached: 'warn', heartbeat_skipped: 'plain',
  rejected: 'bad', sl_hit: 'bad', halt: 'bad', brain_error: 'bad', proposal_blocked: 'bad', risk_alert: 'bad', attention: 'bad', screen_failed: 'bad',
};

function engineActivityKind(kind: string): EngineActivity['kind'] {
  if (kind === 'approved' || kind === 'rejected' || kind === 'approval_needed') return 'approval';
  if (kind === 'halt' || kind === 'cap_reached' || kind === 'risk_alert' || kind === 'brain_error' || kind === 'attention' || kind === 'screen_failed') return 'system';
  if (kind === 'trigger' || kind === 'info_update' || kind === 'screen_done') return 'watch';
  if (kind === 'entry_filled' || kind === 'tp_hit' || kind === 'sl_hit' || kind === 'thread_closed' || kind === 'protection_placed') return 'task_done';
  return 'task_start';
}

/** 同一线程 / 判断 3 分钟内牵动 ≥3 个角色 = 一次「开会」 */
export function deriveMeetings(activity: readonly ActivityItem[], now: number): MeetingSnap[] {
  const groups = new Map<string, { roles: Set<Role>; at: number; symbol: string | null; first: string }>();
  for (const a of activity) {
    if (now - a.at > 6 * 3600_000) continue;
    const key = a.thread_id ?? a.episode_id;
    if (!key) continue;
    const f = activityToFeed(a);
    if (!f) continue;
    const g = groups.get(key) ?? { roles: new Set<Role>(), at: a.at, symbol: a.symbol, first: a.id };
    if (Math.abs(a.at - g.at) > 3 * 60_000) continue;
    if (isRole(f.from)) g.roles.add(f.from);
    if (isRole(f.to)) g.roles.add(f.to);
    g.at = Math.max(g.at, a.at);
    g.symbol = g.symbol ?? a.symbol;
    groups.set(key, g);
  }
  const out: MeetingSnap[] = [];
  for (const [key, g] of groups) {
    if (g.roles.size < 3) continue;
    const roles: Role[] = ['gate_captain', ...[...g.roles].filter((r) => r !== 'gate_captain')];
    out.push({ id: `mt:${key}`, roles, topic: g.symbol ? t('{symbol} 这一单怎么走', { symbol: g.symbol }) : t('这一轮判断'), at: g.at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 5);
}

export function buildFloorModel(inp: FloorInputs): FloorModel {
  const now = inp.now;
  const activity = inp.activity ?? [];
  const ov = inp.overview ?? null;
  const allHandoffs = inp.bots?.handoffs ?? [];
  const pendingHandoffs = allHandoffs.filter((h) => h.status === 'pending').sort((a, b) => b.created_at - a.created_at);
  const pendingIntents = (inp.intents ?? []).filter((i) => i.status === 'pending_approval' && !(i.principal === 'agent' && now - i.at < 5_000)).sort((a, b) => b.at - a.at);

  // ---- feed(交接 + activity 映射)----
  const feed: FeedRow[] = [];
  for (const h of allHandoffs) {
    if (!isRole(h.from_role) || !isRole(h.to_role)) continue;
    feed.push({ key: `hof:${h.handoff_id}`, at: h.created_at, from: h.from_role, to: h.to_role, text: clip(h.summary, 90), source: 'handoff', status: h.status, tone: h.kind === 'alert' || h.kind === 'blocked' ? 'bad' : 'plain' });
  }
  for (const a of activity) {
    const f = activityToFeed(a);
    if (!f) continue;
    const from = f.from === 'user' ? 'user' : isRole(f.from) ? f.from : null;
    const to = f.to === 'user' ? 'user' : isRole(f.to) ? f.to : null;
    if (!from) continue;
    feed.push({ key: `act:${a.id}`, at: a.at, from, to, text: clip(a.title, 90), source: 'activity', status: null, tone: TONE[a.kind] ?? 'plain' });
  }
  feed.sort((a, b) => b.at - a.at);

  // ---- 画布信封:24 小时内、两端都是角色的行 ----
  const handoffs: HandoffSnap[] = feed
    .filter((r) => now - r.at <= HANDOFF_WINDOW && r.from !== 'user' && r.to && r.to !== 'user' && r.from !== r.to)
    .slice(0, 40)
    .map((r) => ({ id: r.key, from: r.from as Role, to: r.to as Role, text: clip(r.text, 40), at: r.at }))
    .reverse();

  // ---- agents ----
  const presenceInputs = {
    overview: ov,
    execution: inp.execution ?? null,
    backtests: null,
    pendingHandoffs: pendingHandoffs.length,
    recentActivity: activity as ActivityItem[],
    now,
  };
  const evoRows: EvoRoleRow[] = (inp.evolution?.roles ?? []).filter((r) => isRole(r.role)).map((r) => ({ role: r.role as Role, days: r.days.slice(-30).map((d) => ({ date: d.date, status: d.status, score: d.score, headline: d.headline, ...(d.events != null ? { events: d.events } : {}) })) }));
  const evoToday = new Map(evoRows.map((r) => [r.role, r.days[r.days.length - 1]]));
  const lastSaid = new Map<Role, FeedRow>();
  for (const r of feed) if (r.from !== 'user' && !lastSaid.has(r.from)) lastSaid.set(r.from, r);

  const byRole = new Map(profilesOf(inp).map((p) => [p.role as Role, p]));
  const agents: AgentSnap[] = ROLE_ORDER.filter((r) => byRole.has(r)).map((role) => {
    const p = byRole.get(role)!;
    const presence: BotPresence = p.presence ?? derivePresence(p, presenceInputs);
    let status = presenceToStatus(presence.state);
    const task = inp.tasks?.[role] ?? null;
    if (task && status === 'idle') status = 'working';
    const said = lastSaid.get(role);
    const line = clip(presence.action || (presence.state === 'off' ? p.note ?? t('没上岗') : '') || said?.text || t('空闲'), 48);
    const ev = evoToday.get(role);
    const today = ev?.headline ? ev.headline : said ? t('最近一件事:{text}', { text: said.text }) : t('今天还没有可说的事。');
    return { role, callsign: ROLES[role].callsign, color: ROLES[role].color, status, line, stats: roleStats(role, inp, pendingIntents.length, pendingHandoffs.length), task, today };
  });

  // ---- inbox ----
  const items: InboxItem[] = [
    ...pendingIntents.map((it) => ({
      id: it.id,
      kind: 'approval' as const,
      title: t('{kind} {symbol} {dir}', { kind: it.kind === 'open' ? t('开仓') : it.kind === 'close' ? t('平仓') : t('减仓'), symbol: it.symbol, dir: it.direction === 'long' ? t('做多') : t('做空') }),
      detail: t('数量 {q} · 止损 {sl}', { q: it.quantity, sl: it.stop_price ?? '—' }),
      at: it.at,
    })),
    ...pendingHandoffs.filter((h) => isRole(h.from_role)).map((h) => ({
      id: h.handoff_id,
      kind: 'handoff' as const,
      title: t('{from} → {to} 的交接待阅', { from: ROLES[h.from_role as Role].callsign, to: isRole(h.to_role) ? ROLES[h.to_role].callsign : h.to_role }),
      detail: clip(h.summary, 60),
      at: h.created_at,
    })),
  ];

  // ---- money ----
  const acct = ov?.account ?? null;
  const equity = acct?.equity ?? (inp.portfolio?.snapshot ? inp.portfolio.snapshot.equity.toFixed(2) : '0');
  const money = { equity, pnl_today: pnlToday(inp), positions: acct?.positions.length ?? 0 };

  // ---- 当前策略 ----
  const st = pickStrategy(inp.strategies, inp.runningStrategyIds);
  const strategy: StrategyCard | undefined = st ? { id: st.id, name: st.name, symbol: st.symbol, stage: STAGE[st.status] ?? 'draft' } : undefined;

  const engineActivity: EngineActivity[] = activity.slice(0, 60).flatMap((a) => {
    const f = activityToFeed(a);
    if (!f) return [];
    const role = f.from === 'user' ? 'user' : isRole(f.from) ? f.from : null;
    return role ? [{ id: a.id, role, kind: engineActivityKind(a.kind), text: a.title, at: a.at }] : [];
  });

  return {
    agents,
    handoffs,
    money,
    inbox: { count: items.length, items },
    meetings: deriveMeetings(activity, now),
    evolution: evoRows,
    activity: engineActivity,
    market: { btc_vol_1h: btcVol1h(inp.btcKlines), risk_level: riskToWeather(inp.risk?.level) },
    ...(strategy ? { strategy } : {}),
    halted: ov?.loop?.halted ?? false,
    paused: ov?.loop?.paused ?? false,
    feed: feed.slice(0, 80),
    pendingIntents,
    pendingHandoffs,
    strategyObj: st,
    deco: buildDeco(inp),
  };
}

// ---------------------------------------------------------------- 布局 A 适配


const ICON: Record<Role, TaskIcon> = {
  gate_captain: 'chat', radar: 'eye', thread_manager: 'chat', strategy_lab: 'flask', portfolio_manager: 'coin',
  risk_sentinel: 'shield', executor: 'bolt', reviewer: 'book', asp_agent: 'shop',
};

/** FloorModel → 布局 A 的 FloorSnapshot(字段名不同、开会带 until、市场带 ticker) */
export function toSnapshotA(m: FloorModel, now: number, ticker: { symbol: string; price: string; chg_pct: number }[] = []): SnapshotA {
  return {
    now,
    agents: m.agents.map((a) => ({
      role: a.role,
      callsign: a.callsign,
      color: a.color,
      status: a.status,
      line: a.line,
      ...(a.stats ? { metrics: a.stats.map((s) => ({ label: s.label, value: s.value })) } : {}),
      task: a.task ? { id: a.task.id, label: a.task.label, icon: ICON[a.role] } : null,
    })),
    handoffs: m.handoffs.map((h) => ({ ...(h.id ? { id: h.id } : {}), from: h.from, to: h.to, text: h.text, at: h.at })),
    money: m.money,
    inbox: { count: m.inbox.count, items: m.inbox.items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, detail: i.detail ?? '', at: i.at })) },
    meetings: (m.meetings ?? []).map((x) => ({ id: x.id, roles: x.roles, topic: x.topic, at: x.at, until: x.at + 45_000 })),
    evolution: (m.evolution ?? []).map((r) => ({ role: r.role, days: r.days })),
    market: {
      ticker,
      volatility_1h_pct: Number(m.market?.btc_vol_1h ?? 0) || 0,
      risk_level: m.market?.risk_level ?? 'low',
      utc_hour: new Date(now).getUTCHours(),
    },
    strategy: m.strategyObj ? { id: m.strategyObj.id, name: m.strategyObj.name, version: `v${m.strategyObj.current_version}` } : null,
    halted: m.halted,
  };
}
