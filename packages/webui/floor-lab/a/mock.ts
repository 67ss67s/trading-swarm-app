/**
 * mock 事件源:唯一的假数据出口。形状贴近真实网关(见 types.ts)。
 * 同一个快照同时喂给画布(信封/开会动画)和右栏(动态流/钱/收件箱),两边天然一致。
 */
import type { AgentSnapshot, AgentStatus, EvoDay, EvoDayDetail, EvoRoleRow, EvoStatus, FloorSnapshot, HandoffSnapshot, InboxItem, MarketState, MeetingSnapshot, RoleId, TeamEvent } from './types';
import { ROLES, ROLE_ORDER } from './roles';
import { TASKS } from './tasks';

type Step = { from: RoleId; to: RoleId; text: string; reply: string; toLine: string; fromLine?: string; fromStatus?: AgentStatus; inbox?: Omit<InboxItem, 'id' | 'at'>; meeting?: { roles: RoleId[]; topic: string } };

/** 几条连贯的「故事线」,按顺序播放,动态流读起来像一个团队在接力 */
const STORIES: Step[][] = [
  [
    { from: 'radar', to: 'thread_manager', text: '发现 SOL 5 分钟急拉 2.1%', reply: '收到,开条线索', toLine: '给 SOL 急拉写论点', fromLine: '继续扫 38 个币的异动', fromStatus: 'working' },
    { from: 'thread_manager', to: 'strategy_lab', text: 'SOL 突破论点,要回测', reply: '好,跑一轮回测', toLine: '回测 SOL 突破 · 90 天', fromLine: '等回测结果', fromStatus: 'waiting' },
    { from: 'strategy_lab', to: 'portfolio_manager', text: '回测通过:胜率 58%,盈亏比 1.9', reply: '收到,算下仓位', toLine: '给 SOL 分配风险预算', fromLine: '整理实验笔记', fromStatus: 'idle' },
    { from: 'portfolio_manager', to: 'risk_sentinel', text: 'SOL 多单 3% 仓位求审', reply: '我来过一遍闸', toLine: '检查 SOL 敞口与止损', fromLine: '等风控结论', fromStatus: 'waiting', meeting: { roles: ['portfolio_manager', 'risk_sentinel', 'executor', 'thread_manager'], topic: 'SOL 开仓会签' } },
    { from: 'risk_sentinel', to: 'executor', text: '风控放行:止损 -1.8%', reply: '准备下单,等你批', toLine: 'SOL 多单待你批准', fromLine: '盯着实时不变量', fromStatus: 'working', inbox: { kind: 'approval', title: 'SOL 多单 0.8 张', detail: 'EXEC 等你批准 · 止损 -1.8% · 仓位 3%', from: 'executor' } },
  ],
  [
    { from: 'asp_agent', to: 'radar', text: 'OKX.AI 买到 1 条 ETH 信号', reply: '收到,加进观察', toLine: '核对 ETH 外部信号', fromLine: '整理市场账本', fromStatus: 'idle' },
    { from: 'radar', to: 'gate_captain', text: 'ETH 资金费转负,值得看', reply: '好,我来排', toLine: '决定 ETH 要不要跟', fromLine: '扫 ETH 链上大额转账', fromStatus: 'working' },
    { from: 'gate_captain', to: 'thread_manager', text: '开一条 ETH 均值回归线程', reply: '接住了', toLine: '写 ETH 均值回归论点', fromLine: '汇总今天的待办', fromStatus: 'working' },
    { from: 'thread_manager', to: 'reviewer', text: '上次 ETH 同类论点亏了,帮看', reply: '我翻翻旧账', toLine: '对比 3 笔 ETH 旧交易', fromLine: '等复盘意见', fromStatus: 'waiting' },
    { from: 'reviewer', to: 'thread_manager', text: '旧账结论:止损太紧', reply: '好,放宽到 2.2%', toLine: '修订 ETH 论点', fromLine: '把教训写进记忆', fromStatus: 'working' },
  ],
  [
    { from: 'executor', to: 'reviewer', text: 'BTC 空单平仓回执 +186 U', reply: '收到,记进复盘', toLine: '复盘 BTC 空单', fromLine: '对账 2 笔成交', fromStatus: 'working' },
    { from: 'reviewer', to: 'strategy_lab', text: 'BTC 策略出场偏早 12 分钟', reply: '我试试晚点出场', toLine: '调 BTC 出场参数', fromLine: '写复盘报告', fromStatus: 'idle' },
    { from: 'strategy_lab', to: 'asp_agent', text: '新版 BTC 信号可以上架', reply: '好,发出去', toLine: '上架 BTC 信号 v3', fromLine: '跑稳健性检验', fromStatus: 'working', meeting: { roles: ['strategy_lab', 'asp_agent', 'gate_captain'], topic: '新信号上架前过一遍' } },
    { from: 'asp_agent', to: 'gate_captain', text: '已上架,3 位订阅者', reply: '干得好', toLine: '看今天的整体进度', fromLine: '回订阅者消息', fromStatus: 'working' },
  ],
];

const STUCK_EVENTS: { role: RoleId; line: string; to: RoleId; text: string }[] = [
  { role: 'risk_sentinel', line: 'BTC 行情过期 47 秒,停止新增风险', to: 'gate_captain', text: 'BTC 行情过期 47 秒' },
  { role: 'executor', line: '交易所回执超时,等待对账', to: 'risk_sentinel', text: '回执超时,请复核' },
  { role: 'radar', line: '新闻源 3 分钟没更新', to: 'gate_captain', text: '新闻源断了一下' },
];

function metricsFor(role: RoleId, equity: number): AgentSnapshot['metrics'] {
  switch (role) {
    case 'gate_captain': return [{ label: '今日交接', value: '38' }, { label: '待你处理', value: '1', tone: 'warn' }, { label: '判断配额', value: '252/1000' }];
    case 'radar': return [{ label: '盯着的币', value: '38' }, { label: '今日异动', value: '14' }, { label: '候选', value: '3', tone: 'up' }];
    case 'thread_manager': return [{ label: '开着的线程', value: '2' }, { label: '今日论点', value: '6' }, { label: '论点胜率', value: '57%', tone: 'up' }];
    case 'strategy_lab': return [{ label: '实验中', value: '4' }, { label: '今日回测', value: '11' }, { label: '最好胜率', value: '58%', tone: 'up' }];
    case 'portfolio_manager': return [{ label: '总敞口', value: '31%' }, { label: '持仓', value: '5' }, { label: '风险预算余', value: '4.2%' }];
    case 'risk_sentinel': return [{ label: '今日拦截', value: '3', tone: 'warn' }, { label: '日亏损', value: '0.41%' }, { label: '上限', value: '3%' }];
    case 'executor': return [{ label: '今日成交', value: '7' }, { label: '保护腿', value: '5/5', tone: 'up' }, { label: '对账', value: '全平' }];
    case 'reviewer': return [{ label: '今日复盘', value: '4' }, { label: '新教训', value: '2' }, { label: '待批记忆', value: '1', tone: 'warn' }];
    case 'asp_agent': return [{ label: '上架信号', value: '3' }, { label: '订阅者', value: '12', tone: 'up' }, { label: '本周收入', value: `${(equity / 1000).toFixed(0)} U` }];
  }
}

const INITIAL: Record<RoleId, { status: AgentStatus; line: string }> = {
  gate_captain: { status: 'working', line: '汇总今天的待办' },
  radar: { status: 'working', line: '扫 38 个币的 5 分钟异动' },
  thread_manager: { status: 'waiting', line: '等新的线索' },
  strategy_lab: { status: 'working', line: '跑 SOL 突破的参数网格' },
  portfolio_manager: { status: 'idle', line: '组合平稳,没什么要动' },
  risk_sentinel: { status: 'working', line: '盯着实时不变量' },
  executor: { status: 'waiting', line: '没有待执行的计划' },
  reviewer: { status: 'idle', line: '昨天的复盘写完了' },
  asp_agent: { status: 'working', line: '回订阅者消息' },
};

export interface MockFeed {
  snapshot(): FloorSnapshot;
  subscribe(fn: (s: FloorSnapshot) => void): () => void;
  approve(id: string): void;
  reject(id: string): void;
  /** 派活(真实入口见 tasks.ts) */
  assign(role: RoleId, taskId: string, symbol?: string): { ok: boolean; msg: string };
  /** 该角色今天一句话小结 */
  todaySummary(role: string): string;
  /** 进化方格某天详情 */
  evoDetail(role: string, date: string): EvoDayDetail;
  /** 紧急停止 */
  halt(): void;
  highFive(role: string): void;
  stop(): void;
}

const EVO_HEAD: Record<EvoStatus, string[]> = {
  good: ['判断命中率高,教训被采纳', '回测结论被实盘验证', '拦下一笔坏单', '论点一路走对'],
  ok: ['平稳,没有新教训', '一次小失误已记录', '产出一般'],
  bad: ['两次判断打脸', '止损过紧被扫', '行情过期导致漏单'],
  none: [],
};

function utcDate(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

function buildEvolution(): EvoRoleRow[] {
  return ROLE_ORDER.map((role, ri) => {
    const days: EvoDay[] = [];
    for (let i = 29; i >= 0; i--) {
      const h = Math.abs(Math.sin((ri + 1) * 91.7 + i * 12.3)) % 1;
      const status: EvoStatus = i === 0 ? 'ok' : h < 0.1 ? 'none' : h < 0.55 ? 'good' : h < 0.83 ? 'ok' : 'bad';
      const heads = EVO_HEAD[status];
      days.push({
        date: utcDate(i),
        status,
        score: status === 'none' ? null : Math.round(status === 'good' ? 70 + h * 30 : status === 'ok' ? 45 + h * 30 : 15 + h * 30),
        headline: heads.length ? heads[Math.floor(h * 97) % heads.length]! : null,
        events: status === 'good' ? 1 + (Math.floor(h * 10) % 3) : status === 'bad' ? Math.floor(h * 10) % 2 : 0,
      });
    }
    return { role, days };
  });
}

const SUMMARIES: Record<RoleId, string> = {
  gate_captain: '今天派了 38 次活,帮你挡掉 2 个没必要的审批,还剩 1 件等你拍板。',
  radar: '扫了 212 个币 36 轮,报了 14 次异动,其中 SOL 那条最值钱。',
  thread_manager: '开了 2 条线程,写了 6 个论点,ETH 那条被复盘打回来改了止损。',
  strategy_lab: '跑了 11 次回测,SOL 突破 v3 胜率 58%,正在等你批准上 paper。',
  portfolio_manager: '组合总敞口 31%,给 SOL 分了 3% 风险预算,其他没动。',
  risk_sentinel: '拦了 3 次:两次行情过期,一次仓位超预算。日亏损 0.41%,离上限远。',
  executor: '成交 7 笔,保护腿 5/5 齐全,对账全平,没有悬空单。',
  reviewer: '复盘了 4 笔交易,提炼 2 条教训,1 条等你批准写进记忆。',
  asp_agent: 'OKX.AI 上架 3 条信号,新增 2 位订阅者,售后 0 投诉。',
};

export function createMockFeed(opts: { intervalMs?: number } = {}): MockFeed {
  const interval = opts.intervalMs ?? 4200;
  let equity = 103649.55;
  let pnl = 312.4;
  let positions = 5;
  const agents = new Map<RoleId, AgentSnapshot>();
  for (const r of ROLE_ORDER) {
    const m = ROLES[r];
    agents.set(r, { role: r, callsign: m.callsign, color: m.color, status: INITIAL[r].status, line: INITIAL[r].line, metrics: metricsFor(r, equity) });
  }
  const handoffs: HandoffSnapshot[] = [];
  const meetings: MeetingSnapshot[] = [];
  let inbox: InboxItem[] = [];
  const evolution = buildEvolution();
  const events: TeamEvent[] = [];
  let halted = false;
  const market: MarketState = {
    ticker: [
      { symbol: 'BTC', price: '84024', chg_pct: 0.24 },
      { symbol: 'ETH', price: '3241.8', chg_pct: 1.21 },
      { symbol: 'SOL', price: '158.42', chg_pct: 3.18 },
      { symbol: 'DOGE', price: '0.1932', chg_pct: -1.23 },
    ],
    volatility_1h_pct: 1.2,
    risk_level: 'low',
    utc_hour: new Date().getUTCHours(),
  };
  const subs = new Set<(s: FloorSnapshot) => void>();
  let seq = 0;
  let story = 0;
  let step = 0;
  let tick = 0;
  let stuckUntil = 0;
  let stuckRole: RoleId | null = null;

  // 预置几条历史,让动态流一开始就有内容
  const t0 = Date.now();
  const seed: [RoleId, RoleId, string, number][] = [
    ['radar', 'thread_manager', '发现 DOGE 放量 3 倍', 540_000],
    ['thread_manager', 'gate_captain', 'DOGE 论点证据不足,先搁置', 420_000],
    ['executor', 'reviewer', 'ETH 止盈回执 +92 U', 260_000],
    ['risk_sentinel', 'portfolio_manager', '总敞口 31%,还在预算内', 120_000],
  ];
  for (const [f, t, text, ago] of seed) handoffs.push({ id: `h${++seq}`, from: f, to: t, text, at: t0 - ago });

  const set = (r: RoleId, status: AgentStatus, line: string) => {
    const a = agents.get(r)!;
    agents.set(r, { ...a, status, line });
  };

  const snap = (): FloorSnapshot => ({
    now: Date.now(),
    agents: ROLE_ORDER.map((r) => agents.get(r)!),
    handoffs: handoffs.slice(-40),
    money: { equity: equity.toFixed(2), pnl_today: (pnl >= 0 ? '+' : '') + pnl.toFixed(2), positions },
    inbox: { count: inbox.length, items: inbox.slice() },
    meetings: meetings.filter((m) => m.until > Date.now() - 60_000).slice(-5),
    evolution,
    events: events.slice(-30),
    market: { ...market, ticker: market.ticker.map((t) => ({ ...t })) },
    strategy: { id: 'st_sol_breakout', name: 'SOL 突破', version: 'v3' },
    halted,
  });
  const pushEvent = (kind: TeamEvent['kind'], role: string, text: string) => events.push({ id: `e${++seq}`, kind, role, text, at: Date.now() });
  const evoTick = (role: RoleId, what: string) => {
    const row = evolution.find((r) => r.role === role)!;
    const today = row.days[row.days.length - 1]!;
    today.events = (today.events ?? 0) + 1;
    if (today.status !== 'good') today.status = 'good';
    today.score = Math.min(100, (today.score ?? 60) + 6);
    today.headline = what;
    pushEvent('evolution', role, `${ROLES[role].callsign} ${what}`);
  };
  const emit = () => {
    const s = snap();
    subs.forEach((f) => f(s));
  };

  const playStep = () => {
    const chain = STORIES[story % STORIES.length]!;
    const st = chain[step]!;
    const now = Date.now();
    handoffs.push({ id: `h${++seq}`, from: st.from, to: st.to, text: st.text, at: now, reply: st.reply });
    set(st.to, st.inbox ? 'waiting' : 'working', st.toLine);
    if (st.fromLine) set(st.from, st.fromStatus ?? 'idle', st.fromLine);
    if (st.inbox) inbox.push({ ...st.inbox, id: `i${++seq}`, at: now });
    if (st.meeting) meetings.push({ id: `m${++seq}`, roles: st.meeting.roles, topic: st.meeting.topic, at: now + 3800, until: now + 3800 + 9000 });
    step++;
    if (step >= chain.length) {
      step = 0;
      story++;
    }
  };

  const loop = () => {
    tick++;
    if (halted) {
      emit();
      return;
    }
    const now = Date.now();
    equity += (Math.random() - 0.46) * 22;
    pnl += (Math.random() - 0.45) * 9;
    // 天气:大约每 40 秒换一种状态,方便看效果(真实数据:1h 波动率 / 风控等级 / UTC 时)
    const phase = Math.floor(tick / 10) % 4;
    market.volatility_1h_pct = phase === 1 ? 3.1 + Math.random() : phase === 2 ? 4.6 : 0.8 + Math.random() * 0.8;
    market.risk_level = phase === 2 ? 'high' : phase === 1 ? 'mid' : 'low';
    market.utc_hour = new Date().getUTCHours();
    for (const t of market.ticker) {
      const p = Number(t.price);
      const np = p * (1 + (Math.random() - 0.48) * 0.003);
      t.price = np >= 100 ? np.toFixed(p >= 10000 ? 0 : 2) : np.toFixed(4);
      t.chg_pct = Math.round((t.chg_pct + (Math.random() - 0.48) * 0.2) * 100) / 100;
    }
    if (tick % 6 === 3) {
      const pool: [RoleId, string][] = [['reviewer', '提炼了 1 条教训'], ['strategy_lab', '验证了 1 条假设'], ['thread_manager', '采纳了 1 条复盘建议'], ['risk_sentinel', '提炼了 1 条风控规则'], ['radar', '验证了 1 个信息源']];
      const [r, w] = pool[Math.floor(tick / 6) % pool.length]!;
      evoTick(r, w);
    }
    if (stuckRole && now > stuckUntil) {
      set(stuckRole, 'working', '恢复正常,继续干活');
      stuckRole = null;
    }
    if (tick % 9 === 5 && !stuckRole) {
      const ev = STUCK_EVENTS[Math.floor(tick / 9) % STUCK_EVENTS.length]!;
      stuckRole = ev.role;
      stuckUntil = now + 11_000;
      set(ev.role, 'stuck', ev.line);
      handoffs.push({ id: `h${++seq}`, from: ev.role, to: ev.to, text: ev.text, at: now, reply: '知道了,先看住' });
    } else {
      playStep();
    }
    emit();
  };

  const timer = window.setInterval(loop, interval);
  const first = window.setTimeout(loop, 1200);

  return {
    snapshot: snap,
    subscribe(fn) {
      subs.add(fn);
      fn(snap());
      return () => subs.delete(fn);
    },
    approve(id) {
      const it = inbox.find((i) => i.id === id);
      inbox = inbox.filter((i) => i.id !== id);
      if (it) {
        const now = Date.now();
        // 真实入口:POST /api/approvals/{id}/approve(审批绑定 plan_hash)
        handoffs.push({ id: `h${++seq}`, from: 'gate_captain', to: 'executor', text: `你批准了:${it.title}`, at: now, reply: '下单中…' });
        pushEvent('approval', 'executor', `你批准了「${it.title}」,EXEC 开始下单`);
        set('executor', 'working', `执行 ${it.title}`);
        positions++;
      }
      emit();
    },
    reject(id) {
      const it = inbox.find((i) => i.id === id);
      inbox = inbox.filter((i) => i.id !== id);
      if (it) {
        handoffs.push({ id: `h${++seq}`, from: 'gate_captain', to: 'executor', text: `你驳回了:${it.title}`, at: Date.now(), reply: '好,撤掉' });
        set('executor', 'idle', '计划已撤销');
      }
      emit();
    },
    assign(role, taskId, symbol) {
      const def = TASKS[role]?.find((t) => t.id === taskId);
      if (!def) return { ok: false, msg: `${ROLES[role].callsign} 不接这个活` };
      if (halted) return { ok: false, msg: '已紧急停止,先解除再派活' };
      const a = agents.get(role)!;
      if (a.task) return { ok: false, msg: `${ROLES[role].callsign} 手上还有活:${a.task.label}` };
      const label = def.needsSymbol ? `${def.label.replace('某币', '')} ${symbol ?? 'SOL'}`.replace('  ', ' ') : def.label;
      const id = `t${++seq}`;
      agents.set(role, { ...a, status: 'working', line: `你派的活:${label}`, task: { id, label, icon: def.icon } });
      pushEvent('task_start', role, `你让 ${ROLES[role].callsign} ${label}`);
      emit();
      window.setTimeout(() => {
        const cur = agents.get(role)!;
        if (cur.task?.id !== id) return;
        agents.set(role, { ...cur, task: null, status: 'working', line: def.result });
        pushEvent('task_done', role, `${ROLES[role].callsign} 完成「${label}」:${def.result}`);
        if (role === 'reviewer') evoTick('reviewer', '提炼了 1 条教训');
        emit();
      }, 5200 + Math.random() * 2500);
      return { ok: true, msg: `已派给 ${ROLES[role].callsign}:${label}` };
    },
    todaySummary(role) {
      return (SUMMARIES as Record<string, string>)[role] ?? '今天还没开工。';
    },
    evoDetail(role, date) {
      const row = evolution.find((r) => r.role === role);
      const d = row?.days.find((x) => x.date === date);
      const sc = d?.score ?? 0;
      return {
        role,
        date,
        metrics: [
          { label: '得分', value: d?.score == null ? '—' : String(sc), tone: d?.status === 'good' ? 'up' : d?.status === 'bad' ? 'down' : 'plain' },
          { label: '进化事件', value: String(d?.events ?? 0) },
          { label: '当天交接', value: String(8 + (sc % 17)) },
        ],
        records: d?.status === 'none' ? [{ at: '—', text: '这天没有上班记录' }] : [
          { at: '09:12', text: d?.headline ?? '平稳的一天' },
          { at: '15:40', text: d?.status === 'bad' ? '复盘:下次行情过期时先暂停新增风险' : '把当天结论写进了记忆(待你批准)' },
        ],
      };
    },
    halt() {
      halted = true;
      for (const r of ROLE_ORDER) set(r, 'stuck', '紧急停止中,等你解除');
      pushEvent('system', 'gate_captain', '你按下了紧急停止:所有 agent 停手');
      emit();
      window.setTimeout(() => {
        halted = false;
        for (const r of ROLE_ORDER) set(r, INITIAL[r].status, INITIAL[r].line);
        pushEvent('system', 'gate_captain', '(演示)紧急停止 20 秒后自动解除');
        emit();
      }, 20_000);
    },
    highFive(role) {
      pushEvent('highfive', role, `你和 ${ROLES[role as RoleId]?.callsign ?? role} 击了个掌`);
      emit();
    },
    stop() {
      window.clearInterval(timer);
      window.clearTimeout(first);
      subs.clear();
    },
  };
}
