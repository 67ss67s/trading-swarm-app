/**
 * 楼层的两段纯函数:
 *   1. derivePresence —— 网关没返回 presence 时的前端兜底(设计稿 §3 表);网关返回了就原样用。
 *   2. activityToFeed / mergeFeed —— activity 映射成 from→to 的展示行(设计稿 §4),
 *      与真 bot_handoffs 行合并、按时间倒序;映射行标 source='activity',视觉上区分。
 *
 * 全是展示逻辑,不写回任何东西;文本一律按 untrusted data 处理(纯文本渲染)。
 */
import { t, tmap } from '@/lib/i18n';
import type { ActivityItem, BacktestListResponse, ExecutionView, Overview } from '@/api/types';
import type { BotHandoff, BotPresence, BotProfileWithPresence as BotProfile, BotRole, FeedItem, HandoffKind } from './types';

export interface PresenceInputs {
  overview: Overview | null | undefined;
  execution: ExecutionView | null | undefined;
  backtests: BacktestListResponse | null | undefined;
  pendingHandoffs: number;
  recentActivity: ActivityItem[];
  now: number;
}

const STEP_LABEL: Record<string, string> = tmap({
  fetching: '拉行情',
  context: '组证据',
  thinking: '模型思考中',
  validating: '校验输出',
  gating: '过风险闸',
  executing: '交给执行',
  done: '收尾',
});

const KIND_LABEL: Record<string, string> = tmap({ scan: '扫描', review: '复查', info: '信息员', chat: '对话' });

function idle(action: string | null = null, next_at: number | null = null): BotPresence {
  return { state: 'idle', action, since: null, next_at };
}
function off(action: string | null): BotPresence {
  return { state: 'off', action, since: null, next_at: null };
}

/** 前端兜底口径。只在 profile.presence 缺失时调用。 */
export function derivePresence(profile: BotProfile, inp: PresenceInputs): BotPresence {
  const ov = inp.overview;
  const loop = ov?.loop;
  const queue = ov?.queue;
  const running = queue?.running ?? null;
  const halted = loop?.halted ?? false;
  const threads = ov?.threads ?? [];
  const cutoff = inp.now - 5 * 60_000;

  switch (profile.role) {
    case 'thread_manager': {
      if (running && (running.kind === 'scan' || running.kind === 'review')) {
        const step = running.step ? STEP_LABEL[running.step] ?? running.step : null;
        return { state: 'thinking', action: `${KIND_LABEL[running.kind] ?? running.kind} ${running.symbol ?? ''}${step ? ` · ${step}` : ''}`.trim(), since: null, next_at: null };
      }
      if (inp.recentActivity.some((a) => a.kind === 'brain_error' && a.at >= cutoff)) return { state: 'blocked', action: t('上一次模型输出读不出来'), since: null, next_at: null };
      if ((queue?.pending ?? 0) > 0) return { state: 'waiting', action: t('队列里还有 {n} 个判断', { n: queue!.pending }), since: null, next_at: null };
      if (loop?.paused) return idle(t('已暂停,到点不调模型'), null);
      return idle(t('守着 {n} 条线程', { n: threads.length }), loop?.next_at ?? null);
    }
    case 'radar': {
      if (running && running.kind === 'info') return { state: 'working', action: t('在梳理市场状态'), since: null, next_at: null };
      const ms = ov?.market_state;
      return idle(ms ? t('候选 {c} · 风险事件 {r}', { c: ms.candidates.length, r: ms.risk_events.length }) : t('还没有市场状态'), null);
    }
    case 'executor': {
      const conn = inp.execution?.connection.status;
      if (inp.execution && conn && conn !== 'connected') return { state: conn === 'needs_auth' ? 'blocked' : 'off', action: inp.execution.connection.detail || t('执行后端没就绪'), since: null, next_at: null };
      if (halted) return { state: 'blocked', action: t('紧急停止:一切开仓都拒'), since: null, next_at: null };
      const attn = threads.find((x) => x.attention);
      if (attn) return { state: 'blocked', action: t('{symbol} 要你处理', { symbol: attn.symbol }), since: null, next_at: null };
      const pending = threads.filter((x) => x.status === 'pending_entry');
      if (pending.length) return { state: 'waiting', action: t('{list} 挂单等成交', { list: pending.map((x) => x.symbol).join(' / ') }), since: null, next_at: null };
      const inPos = threads.filter((x) => x.status === 'in_position');
      return idle(inPos.length ? t('盯着 {n} 个持仓的保护腿', { n: inPos.length }) : t('后端 {backend} · 没有待执行', { backend: loop?.backend ?? '—' }), null);
    }
    case 'gate_captain': {
      if (inp.pendingHandoffs > 0) return { state: 'waiting', action: t('{n} 条交接待读', { n: inp.pendingHandoffs }), since: null, next_at: null };
      const needs = inp.recentActivity.find((a) => a.kind === 'approval_needed' && a.at >= inp.now - 6 * 3600_000);
      if (needs) return { state: 'waiting', action: needs.title, since: needs.at, next_at: null };
      return idle(t('收件箱空'), null);
    }
    case 'risk_sentinel': {
      if (halted) return { state: 'working', action: t('紧急停止生效中:代码闸拒绝一切开仓'), since: null, next_at: null };
      const dl = Number((ov as { daily_loss_pct?: string } | null | undefined)?.daily_loss_pct ?? 0);
      const cap = Number(ov?.workflow?.daily_loss_stop_pct ?? 0);
      if (cap > 0 && dl >= cap * 0.7) return { state: 'waiting', action: t('日亏 {v}% 接近上限 {cap}%', { v: dl.toFixed(2), cap }), since: null, next_at: null };
      return idle(t('盯着(纯代码闸)'), null);
    }
    case 'strategy_lab': {
      if (inp.backtests?.running) return { state: 'working', action: t('回测跑批中'), since: null, next_at: null };
      return profile.enabled ? idle(null) : off(profile.note);
    }
    default:
      return profile.enabled ? idle(null) : off(profile.note);
  }
}

// ---------------------------------------------------------------- activity → feed

type Route = { from: BotRole | 'user'; to: BotRole | 'user'; kind: HandoffKind; dim?: boolean };

const ROUTES: Record<string, Route> = {
  trigger: { from: 'radar', to: 'thread_manager', kind: 'request' },
  info_update: { from: 'radar', to: 'gate_captain', kind: 'result' },
  proposal: { from: 'thread_manager', to: 'gate_captain', kind: 'request' },
  proposal_blocked: { from: 'risk_sentinel', to: 'thread_manager', kind: 'blocked' },
  approval_needed: { from: 'gate_captain', to: 'user', kind: 'request' },
  approved: { from: 'user', to: 'executor', kind: 'result' },
  rejected: { from: 'user', to: 'thread_manager', kind: 'result' },
  thread_opened: { from: 'executor', to: 'thread_manager', kind: 'result' },
  entry_filled: { from: 'executor', to: 'thread_manager', kind: 'result' },
  protection_placed: { from: 'executor', to: 'thread_manager', kind: 'result' },
  tp_hit: { from: 'executor', to: 'thread_manager', kind: 'result' },
  sl_hit: { from: 'executor', to: 'thread_manager', kind: 'result' },
  thread_canceled: { from: 'executor', to: 'thread_manager', kind: 'result' },
  thread_closed: { from: 'thread_manager', to: 'reviewer', kind: 'result' },
  thread_invalidated: { from: 'thread_manager', to: 'reviewer', kind: 'result' },
  attention: { from: 'executor', to: 'gate_captain', kind: 'alert' },
  attention_cleared: { from: 'executor', to: 'gate_captain', kind: 'result' },
  halt: { from: 'risk_sentinel', to: 'gate_captain', kind: 'alert' },
  cap_reached: { from: 'risk_sentinel', to: 'gate_captain', kind: 'alert' },
  resume: { from: 'user', to: 'gate_captain', kind: 'result' },
  paused: { from: 'user', to: 'gate_captain', kind: 'result' },
  resumed: { from: 'user', to: 'gate_captain', kind: 'result' },
  workflow_changed: { from: 'user', to: 'gate_captain', kind: 'result', dim: true },
  execution_changed: { from: 'user', to: 'executor', kind: 'result' },
  brain_error: { from: 'thread_manager', to: 'gate_captain', kind: 'blocked' },
  heartbeat_skipped: { from: 'radar', to: 'thread_manager', kind: 'result', dim: true },
  manual_order: { from: 'user', to: 'executor', kind: 'request' },
  chat_action: { from: 'user', to: 'gate_captain', kind: 'request', dim: true },
  screen_done: { from: 'radar', to: 'gate_captain', kind: 'result' },
  screen_failed: { from: 'radar', to: 'gate_captain', kind: 'blocked' },
  risk_alert: { from: 'risk_sentinel', to: 'gate_captain', kind: 'alert' },
  risk_cleared: { from: 'risk_sentinel', to: 'gate_captain', kind: 'result' },
  brief: { from: 'gate_captain', to: 'user', kind: 'result' },
};

export function activityToFeed(a: ActivityItem): FeedItem | null {
  const r = ROUTES[a.kind];
  if (!r) return null;
  return {
    id: `act:${a.id}`,
    at: a.at,
    source: 'activity',
    activity_kind: a.kind,
    from: r.from,
    to: r.to,
    kind: r.kind,
    summary: a.title,
    detail: a.detail,
    symbol: a.symbol,
    status: null,
    handoff: null,
    dim: Boolean(r.dim),
  };
}

export function handoffToFeed(h: BotHandoff): FeedItem {
  return {
    id: `hof:${h.handoff_id}`,
    at: h.created_at,
    source: 'handoff',
    from: h.from_role,
    to: h.to_role,
    kind: h.kind,
    summary: h.summary,
    detail: h.subject ? `${h.subject.type} · ${h.subject.id}` : null,
    symbol: null,
    status: h.status,
    handoff: h,
    dim: false,
  };
}

export function mergeFeed(handoffs: BotHandoff[], activity: ActivityItem[], limit = 80): FeedItem[] {
  const rows: FeedItem[] = [];
  for (const h of handoffs) rows.push(handoffToFeed(h));
  for (const a of activity) {
    const f = activityToFeed(a);
    if (f) rows.push(f);
  }
  rows.sort((x, y) => y.at - x.at);
  return rows.slice(0, limit);
}

/** 每个角色「最近一句」:桌上小屏用。 */
export function lastLineByRole(feed: FeedItem[]): Partial<Record<BotRole, FeedItem>> {
  const out: Partial<Record<BotRole, FeedItem>> = {};
  for (const f of feed) {
    if (f.from !== 'user' && !out[f.from]) out[f.from] = f;
  }
  return out;
}
