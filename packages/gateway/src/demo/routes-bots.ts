/**
 * Bot 团队注册表的只读 + 「已阅」路由(bots.ts)。在 http-extra.ts 里一行注册。
 *
 * presence 不落库、不由模型写:每次请求从运行时状态**推导**(notebook §12「模型不能直接设置动画状态」)。
 * 交接文本是 untrusted data;ack 只是「人看过了」,不构成任何授权。
 */
import { BOT_ROLES, type BotProfile, type BotRole } from './bots.js';
import type { RouteContext, RouteModule } from './http-extra.js';
import type { DemoRuntime } from './runtime.js';
import { HORIZON_LABEL } from './screener.js';

export type PresenceState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done' | 'off';

export interface Presence {
  state: PresenceState;
  action: string | null;
  since: number | null;
  next_at: number | null;
}

export type BotView = BotProfile & { presence: Presence };

const idle = (next_at: number | null = null): Presence => ({ state: 'idle', action: null, since: null, next_at });

/** 纯函数:角色 × 运行时状态 → presence。 */
export function presenceFor(role: BotRole, rt: DemoRuntime, enabled: boolean, now = Date.now()): Presence {
  if (!enabled) return { state: 'off', action: role === 'executor' && rt.executorControl.active ? '暂停中：等待当前操作完成' : '已暂停', since: null, next_at: null };
  // gate_captain 的 dispatcher 还没做(enabled=false),但「收件箱」这一半今天就在:有待阅交接时它就是 waiting,
  // 不能一边灰着一边收件箱亮着。
  if (role === 'gate_captain') {
    const pending = rt.store.bots.handoffs({ status: 'pending', to_role: 'gate_captain', limit: 50 }).length;
    if (pending) return { state: 'waiting', action: `${pending} 条交接待阅`, since: null, next_at: null };
  }
  if (!enabled) return { state: 'off', action: null, since: null, next_at: null };
  const halted = rt.isHalted;
  switch (role) {
    case 'asp_agent': {
      const a = rt.marketAgent(); const inbox = a.inbox.status();
      const pending = a.aftersales.rows().filter((x) => x['status'] === 'pending').length;
      return { state: pending ? 'waiting' : inbox.alive || a.settings().publisher.enabled ? 'working' : 'idle', action: pending ? `${pending} 条售后待处理` : inbox.alive ? '接收入站投递' : a.settings().publisher.enabled ? '发布器已启用' : null, since: inbox.last_poll, next_at: null };
    }
    case 'radar': {
      const sched = rt.radar.schedule();
      const running = sched.find((s) => s.running);
      if (running) {
        const p = running.progress;
        return { state: 'working', action: `${running.label}筛选${p ? ` ${p.done}/${p.total}` : ''}`, since: null, next_at: null };
      }
      const next = sched.filter((s) => s.enabled && s.next_at !== null).map((s) => ({ at: s.next_at!, label: s.label })).sort((a, b) => a.at - b.at)[0];
      if (rt.workflow.paused) return { state: 'waiting', action: '已暂停:到点不筛', since: null, next_at: next?.at ?? null };
      return { state: 'idle', action: next ? `下次 ${next.label}筛选` : null, since: null, next_at: next?.at ?? null };
    }
    case 'thread_manager': {
      const q = rt.queueView();
      // 对话轮次归 gate_captain(按任务类型归属),这里只认 scan / review。
      if (q.running && q.running.kind !== 'chat') return { state: 'thinking', action: `${q.running.kind === 'review' ? '复查' : q.running.kind === 'scan' ? '扫描' : q.running.kind} ${q.running.symbol ?? ''}`.trim(), since: null, next_at: null };
      if (q.pending > 0) return { state: 'waiting', action: `${q.pending} 个判断排队`, since: null, next_at: null };
      if (halted) return { state: 'blocked', action: '紧急停止:只允许 NO_TRADE', since: null, next_at: null };
      const loop = rt.loopView();
      return idle(loop.next_at ?? null);
    }
    case 'executor': {
      const ev = rt.executionView();
      const st = String(ev.connection.status);
      if (halted) return { state: 'blocked', action: '紧急停止:不接新单', since: ev.connection.checked_at, next_at: null };
      if (/error|fail|revoked|expired|needs_auth|unauthorized|missing/i.test(st)) return { state: 'blocked', action: ev.connection.detail, since: ev.connection.checked_at, next_at: null };
      return { state: 'idle', action: null, since: ev.connection.checked_at, next_at: null };
    }
    case 'risk_sentinel': {
      // 紧急停止 / high 以上告警 = 它在**干活**(压着新增风险),不是它被挡住。
      if (halted) return { state: 'working', action: '紧急停止生效中', since: null, next_at: null };
      const lvl = rt.riskLevel();
      const open = rt.riskOpen;
      if (lvl === 'critical' || lvl === 'high') return { state: 'working', action: `${open.filter((a) => a.auto_action === 'block_new_risk').length} 条 ${lvl} 告警,停止新增风险`, since: Math.min(...open.map((a) => a.first_seen_at)), next_at: null };
      if (lvl === 'warn') return { state: 'waiting', action: `${open.length} 条 warn 告警待阅`, since: Math.min(...open.map((a) => a.first_seen_at)), next_at: null };
      if (!rt.portfolioSnapshot) return { state: 'waiting', action: '等第一次账户快照', since: null, next_at: null };
      return { state: 'idle', action: '不变量全过', since: rt.portfolioSnapshot.observed_at, next_at: null };
    }
    case 'portfolio_manager': {
      const snap = rt.portfolioSnapshot;
      if (!snap) return { state: 'waiting', action: '等第一次账户快照', since: null, next_at: null };
      if (snap.quality !== 'ok') return { state: 'blocked', action: `账户快照 ${snap.quality}${snap.quality_note ? `:${snap.quality_note.slice(0, 40)}` : ''}`, since: snap.observed_at, next_at: null };
      return { state: 'idle', action: `总敞口 ${snap.projected.gross_ratio.toFixed(2)}×,${Object.keys(snap.by_cluster).length} 个风险簇`, since: snap.observed_at, next_at: null };
    }
    case 'gate_captain': {
      const q = rt.queueView();
      if (q.running?.kind === 'chat') return { state: 'thinking', action: '回答对话', since: null, next_at: null };
      const pending = rt.store.bots.handoffs({ status: 'pending', to_role: 'gate_captain', limit: 50 }).length;
      if (pending) return { state: 'waiting', action: `${pending} 条交接待阅`, since: null, next_at: null };
      const b = rt.team.latestBrief();
      return { state: 'idle', action: b ? '收件箱清空;今日简报已出' : '收件箱清空', since: b?.to ?? null, next_at: null };
    }
    case 'strategy_lab': {
      if (rt.team.labIsRunning()) return { state: 'working', action: '机械期望实验在跑', since: null, next_at: null };
      const bt = rt.store.backtestRuns(5).find((r) => r.status === 'running' || r.status === 'queued');
      if (bt) return { state: 'working', action: `回测 ${bt.id} 在跑`, since: bt.created_at ?? null, next_at: null };
      const d = rt.team.labDecision();
      return { state: d.run ? 'waiting' : 'idle', action: d.reason, since: d.last_at, next_at: d.last_at === null ? null : d.last_at + 7 * 86_400_000 };
    }
    case 'reviewer': {
      if (rt.reviewer.isThinking()) return { state: 'thinking', action: '批量复盘提炼教训', since: null, next_at: null };
      const d = rt.reviewer.decision();
      if (rt.workflow.paused && d.pending > 0) return { state: 'waiting', action: `已暂停;${d.pending} 笔待复盘`, since: null, next_at: null };
      if (d.pending > 0) return { state: 'waiting', action: `${d.pending} 笔平仓待批次(≥5 或 24h)`, since: null, next_at: d.last_batch_at === null ? null : d.last_batch_at + 24 * 3_600_000 };
      return { state: 'idle', action: d.last_batch_at ? '没有新平仓' : '还没有平仓可复盘', since: d.last_batch_at, next_at: null };
    }
    default:
      return idle();
  }
  void now;
}

export function botViews(rt: DemoRuntime): BotView[] {
  return rt.store.bots.profiles().map((b) => ({ ...b, presence: presenceFor(b.role, rt, b.enabled) }));
}

export const botRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail, rt, store } = ctx;
  const bots = store.bots;

  route('GET', '/api/bots', guarded(async (_req, res) => {
    json(res, 200, {
      bots: botViews(rt),
      runs: bots.runs({ limit: 20 }),
      handoffs: bots.handoffs({ limit: 20 }),
      horizon_labels: HORIZON_LABEL,
    });
  }));

  route('POST', '/api/bots/:role/enabled', guarded(async (req, res, _url, p) => {
    const role = p['role'];
    const body = await ctx.readBody(req);
    if (!body || typeof body['enabled'] !== 'boolean') return fail(res, 400, 'enabled 必须是布尔值', 'bad_enabled');
    if (role !== 'all' && !BOT_ROLES.includes(role as BotRole)) return fail(res, 404, '未知 Agent', 'not_found');
    rt.setBotsEnabled(role === 'all' ? BOT_ROLES : [role as BotRole], body['enabled']);
    json(res, 200, { bots: botViews(rt) });
  }));

  route('GET', '/api/bots/runs', guarded(async (_req, res, url) => {
    const role = url.searchParams.get('role') ?? undefined;
    const routine = url.searchParams.get('routine') ?? undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    json(res, 200, { runs: bots.runs({ ...(role ? { role } : {}), ...(routine ? { routine } : {}), limit }) });
  }));

  route('GET', '/api/bots/handoffs', guarded(async (_req, res, url) => {
    const status = url.searchParams.get('status');
    const to = url.searchParams.get('to_role') ?? undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    if (status && status !== 'pending' && status !== 'acked') return fail(res, 400, 'status 只能是 pending 或 acked', 'bad_status');
    json(res, 200, { handoffs: bots.handoffs({ ...(status ? { status: status as 'pending' | 'acked' } : {}), ...(to ? { to_role: to } : {}), limit }) });
  }));

  route('POST', '/api/bots/handoffs/:id/ack', guarded(async (_req, res, _url, p) => {
    const h = bots.ack(p['id']!);
    if (!h) return fail(res, 404, `没有交接 ${p['id']}`, 'not_found');
    ctx.emit('bots.changed', { handoff_id: h.handoff_id });
    json(res, 200, { handoff: h });
  }));
};
