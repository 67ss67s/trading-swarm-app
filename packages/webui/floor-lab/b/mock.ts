/**
 * Mock 事件源:原型页唯一的数据来源。动态流(右栏)和动画(信封 / 开会)都吃同一份 Snapshot,
 * 所以两边永远一致。形状见 types.ts,贴近真实 /api/bots、/api/activity、overview、execution。
 */
import { ROLES, ROLE_ORDER } from './roles';
import type { ActivityItem, MarketState, StrategyCard, TaskDef, AgentSnap, AgentStatus, EvoDay, EvoDayDetail, EvoKind, EvoRoleRow, EvoStatus, HandoffSnap, InboxItem, MeetingSnap, Role, Snapshot } from './types';

const STATS: Record<Role, { label: string; value: string }[]> = {
  gate_captain: [{ label: '进行中任务', value: '4' }, { label: '待你审批', value: '2' }, { label: '今日判断', value: '252/1000' }],
  radar: [{ label: '信息源', value: '39' }, { label: '今日候选', value: '12' }, { label: '急动告警', value: '7' }],
  thread_manager: [{ label: '开着的论点', value: '5' }, { label: '今日提议', value: '3' }, { label: '论点胜率', value: '57%' }],
  strategy_lab: [{ label: '在跑回测', value: '3' }, { label: 'paper 策略', value: '2' }, { label: '最佳 Sharpe', value: '1.42' }],
  portfolio_manager: [{ label: '总敞口', value: '38%' }, { label: '净敞口', value: '+12%' }, { label: '风险预算余', value: '61%' }],
  risk_sentinel: [{ label: '今日拒单', value: '4' }, { label: '在岗闸门', value: '11' }, { label: '今日亏损', value: '0.41%/3%' }],
  executor: [{ label: '今日成交', value: '9' }, { label: '保护腿在位', value: '5/5' }, { label: '平均滑点', value: '0.03%' }],
  asp_agent: [{ label: '订阅中信号', value: '6' }, { label: '今日入站', value: '14' }, { label: '已发布', value: '2' }],
  reviewer: [{ label: '今日复盘', value: '7' }, { label: '候选教训', value: '3' }, { label: '归因完成', value: '92%' }],
};

const INIT: Record<Role, [AgentStatus, string]> = {
  gate_captain: ['working', '汇总今天的待办'],
  radar: ['working', '扫描 23 个币的 5 分钟异动'],
  thread_manager: ['working', '整理 ETH 突破论点'],
  strategy_lab: ['working', '回测均值回归 v3'],
  portfolio_manager: ['waiting', '等 THREAD 的新论点'],
  risk_sentinel: ['working', '盯着账户快照新鲜度'],
  executor: ['idle', '没有待执行的计划'],
  asp_agent: ['working', '整理 OKX.AI 入站信号'],
  reviewer: ['idle', '今天的复盘写完了'],
};

/** 一条条「讲得通」的交接链:信息流自上而下,偶尔回流 */
interface Step { from: Role; to: Role; text: string; reply: string; toLine: string; fromLine?: string }
const CHAINS: Step[][] = [
  [
    { from: 'radar', to: 'thread_manager', text: '发现 SOL 5 分钟急拉 +1.2%', reply: '收到,我看看结构', toLine: '判断 SOL 急拉是不是突破' },
    { from: 'thread_manager', to: 'portfolio_manager', text: '提出 SOL 回踩做多论点', reply: '我算下仓位', toLine: '给 SOL 分配风险预算' },
    { from: 'portfolio_manager', to: 'risk_sentinel', text: '建议 SOL 仓位 2% 权益', reply: '过闸中…', toLine: '检查 SOL 订单 11 道闸' },
    { from: 'risk_sentinel', to: 'executor', text: '放行 SOL 计划,止损已绑定', reply: '下单!', toLine: '执行 SOL 限价单' },
    { from: 'executor', to: 'reviewer', text: '成交 0.8 SOL @ 158.42', reply: '记进账本', toLine: '给 SOL 入场做归因' },
  ],
  [
    { from: 'asp_agent', to: 'radar', text: '收到 OKX.AI 新信号:BTC 多', reply: '我交叉验证一下', toLine: '核对 BTC 外部信号' },
    { from: 'radar', to: 'gate_captain', text: '确认 BTC 资金费率转正', reply: '好,我排进议程', toLine: '安排 BTC 议题' },
    { from: 'gate_captain', to: 'thread_manager', text: '派活:评估 BTC 趋势延续', reply: '接了', toLine: '写 BTC 趋势论点' },
  ],
  [
    { from: 'reviewer', to: 'strategy_lab', text: '复盘:ETH 入场普遍早 0.3%', reply: '我拿去调参', toLine: '回测入场延迟参数' },
    { from: 'strategy_lab', to: 'gate_captain', text: '新参数回测胜率 58%', reply: '要人批才能上 paper', toLine: '把晋升提案送审' },
  ],
  [
    { from: 'risk_sentinel', to: 'gate_captain', text: '报警:BTC 行情陈旧 47 秒', reply: '先停新开仓', toLine: '处理行情陈旧告警' },
    { from: 'gate_captain', to: 'executor', text: '暂停新开仓 5 分钟', reply: '已暂停', toLine: '暂停中,只管保护腿' },
  ],
  [
    { from: 'executor', to: 'portfolio_manager', text: '对账完成,持仓 5 笔全对上', reply: '好,更新敞口', toLine: '重算组合敞口' },
    { from: 'portfolio_manager', to: 'asp_agent', text: '可以对外发布 ETH 观点', reply: '上架!', toLine: '发布 ETH 信号到 OKX.AI' },
  ],
];

const MEETINGS: { roles: Role[]; topic: string }[] = [
  { roles: ['gate_captain', 'thread_manager', 'portfolio_manager', 'risk_sentinel'], topic: 'SOL 急拉要不要跟?' },
  { roles: ['gate_captain', 'radar', 'strategy_lab'], topic: '本周筛选口径要不要收紧' },
  { roles: ['gate_captain', 'reviewer', 'strategy_lab', 'thread_manager'], topic: '复盘:为什么 ETH 连亏两笔' },
];

const TODAY: Record<Role, string> = {
  gate_captain: '今天派了 14 个活,开了 2 次会,还有 2 件等你拍板。',
  radar: '扫了 6 轮全市场,抓到 SOL、XRP 两次急拉,都交给 THREAD 了。',
  thread_manager: '写了 3 个论点,SOL 回踩做多那个已经过了风控。',
  strategy_lab: '跑了 5 组回测,均值回归 v3 最好,等你批准上 paper。',
  portfolio_manager: '敞口从 45% 降到 38%,风险预算还剩 61%。',
  risk_sentinel: '拦下 4 单(2 单止损太远,2 单行情陈旧),没放过一单违规。',
  executor: '成交 9 笔,平均滑点 0.03%,保护腿一直在位。',
  asp_agent: '收了 14 条 OKX.AI 信号,发布了 1 条 ETH 观点。',
  reviewer: '复盘了 7 笔交易,提炼 3 条教训,其中 1 条已验证。',
};

export interface MockSource {
  snapshot(): Snapshot;
  start(onChange: (s: Snapshot) => void): () => void;
  evoDetail(role: Role, date: string): EvoDayDetail | null;
  /** 派活(真实入口见 TaskDef.real) */
  dispatch(role: Role, task: TaskDef): void;
  /** 审批待批订单(真实入口 POST /api/approvals/:id {decision}) */
  approve(id: string, ok: boolean): void;
  /** 运行策略(真实入口 §9.51 POST /api/strategy-runs) */
  runStrategy(symbol: string, mode: 'paper' | 'live'): void;
  /** 紧急停止(真实入口 POST /api/emergency-stop) */
  emergency(): void;
  /** 用户自己的动作也进动态流 */
  note(text: string): void;
}

// ---------- 进化方格 mock ----------
const EVO_HEADLINES: Record<EvoStatus, string[]> = {
  good: ['判断命中率 68%,提炼 2 条教训', '回测结论被采纳进 paper', '零误报,告警全部有效', '入场时机比上周提前 0.2%'],
  ok: ['表现平稳,没有新教训', '命中率 51%,持平', '两条候选教训待验证'],
  bad: ['连续两次误判方向', '行情陈旧告警漏报 1 次', '回测过拟合被 AUDIT 打回'],
  none: [],
};
const EVO_EVENT_TEXT: Record<EvoKind, string[]> = {
  distill: ['追涨前先看 15 分钟结构', '资金费率翻负时降低仓位', '突破无量就别追'],
  verify: ['「急拉后回踩」教训在 3 笔上复现', '「陈旧行情停新开仓」有效'],
  adopt: ['入场延迟参数 v3 进入 paper', '风险预算上限改为 2%'],
};
function seeded(n: number): number {
  const s = Math.sin(n * 91.7 + 13.3) * 43758.5453;
  return s - Math.floor(s);
}
function utcDate(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function buildEvolution(): EvoRoleRow[] {
  return ROLE_ORDER.map((role, ri) => {
    const days: EvoDay[] = [];
    for (let k = 29; k >= 0; k--) {
      const r = seeded(ri * 37 + k);
      // 新角色(MARKET)前半段没有数据
      const status: EvoStatus = role === 'asp_agent' && k > 12 ? 'none' : r < 0.08 ? 'none' : r < 0.52 ? 'good' : r < 0.82 ? 'ok' : 'bad';
      const hl = EVO_HEADLINES[status];
      const events = status === 'good' && seeded(ri + k * 3) > 0.45 ? 1 + Math.floor(seeded(ri * k + 5) * 3) : status === 'ok' && seeded(ri + k) > 0.8 ? 1 : 0;
      days.push({
        date: utcDate(k),
        status: k === 0 ? 'ok' : status,
        score: status === 'none' ? null : Math.round(40 + r * 55),
        headline: hl.length ? hl[Math.floor(seeded(ri + k * 7) * hl.length)]! : null,
        events: k === 0 ? 0 : events,
      });
    }
    return { role, days };
  });
}

export function createMock(): MockSource {
  const now = Date.now();
  const agents: AgentSnap[] = ROLE_ORDER.map((r) => ({
    role: r,
    callsign: ROLES[r].callsign,
    color: ROLES[r].color,
    status: INIT[r][0],
    line: INIT[r][1],
    stats: STATS[r],
  }));
  const handoffs: HandoffSnap[] = [
    { id: 'h0', from: 'radar', to: 'thread_manager', text: '发现 ETH 资金费率翻负', at: now - 7 * 60_000, reply: '收到' },
    { id: 'h1', from: 'thread_manager', to: 'portfolio_manager', text: '提出 ETH 逢低做多论点', at: now - 5 * 60_000, reply: '我算下仓位' },
    { id: 'h2', from: 'executor', to: 'reviewer', text: '平掉 XRP,盈 +0.6%', at: now - 3 * 60_000, reply: '记下了' },
  ];
  const inboxItems: InboxItem[] = [
    { id: 'i1', kind: 'approval', title: 'SOL 多单 · 等你批', detail: 'THREAD 提议 0.8 SOL @ 158.4,止损 154.9', at: now - 90_000 },
    { id: 'i2', kind: 'handoff', title: 'LAB 想把「均值回归 v3」升到 paper', detail: '回测 90 天胜率 58%,需要人批', at: now - 40_000 },
  ];
  const meetings: MeetingSnap[] = [];
  const evolution = buildEvolution();
  const activity: ActivityItem[] = [];
  const market: MarketState = { btc_vol_1h: '0.9', risk_level: 'mid' };
  const strategy: StrategyCard = { id: 'st_mr_v3', name: '均值回归 v3', symbol: 'ETHUSDT', stage: 'paper' };
  agents.forEach((a) => { a.today = TODAY[a.role]; a.task = null; });
  let emit: (s: Snapshot) => void = () => {};
  const act = (role: Role | 'user', kind: ActivityItem['kind'], text: string) => {
    seq += 1;
    activity.push({ id: `a${seq}`, role, kind, text, at: Date.now() });
    if (activity.length > 60) activity.shift();
  };
  let equity = 103649.55;
  let pnl = 312.4;
  let positions = 5;
  let seq = 0;
  let chainIdx = 0;
  let stepIdx = 0;
  let meetIdx = 0;

  const agent = (r: Role) => agents.find((a) => a.role === r)!;

  function snapshot(): Snapshot {
    return {
      agents: agents.map((a) => ({ ...a })),
      handoffs: handoffs.slice(-40),
      money: { equity: equity.toFixed(2), pnl_today: (pnl >= 0 ? '+' : '') + pnl.toFixed(2), positions },
      inbox: { count: inboxItems.length, items: inboxItems.slice() },
      meetings: meetings.slice(-5),
      evolution: evolution.map((r) => ({ role: r.role, days: r.days.map((d) => ({ ...d })) })),
      activity: activity.slice(-40),
      market: { ...market },
      strategy: { ...strategy },
    };
  }

  function tickHandoff() {
    const chain = CHAINS[chainIdx % CHAINS.length]!;
    const st = chain[stepIdx]!;
    seq += 1;
    handoffs.push({ id: `m${seq}`, from: st.from, to: st.to, text: st.text, at: Date.now(), reply: st.reply });
    const f = agent(st.from);
    const t = agent(st.to);
    // 发出方干完这一手:大概率转空闲 / 等待
    f.status = Math.random() < 0.5 ? 'idle' : 'waiting';
    f.line = f.status === 'idle' ? '这一手交出去了,歇会儿' : `等 ${ROLES[st.to].callsign} 回话`;
    t.status = 'working';
    t.line = st.toLine;
    if (st.to === 'executor' && st.text.includes('放行')) {
      positions += 1;
    }
    stepIdx += 1;
    if (stepIdx >= chain.length) {
      stepIdx = 0;
      chainIdx += 1;
    }
    // 偶尔有人卡住,几秒后恢复
    if (Math.random() < 0.12) {
      const victim = agents[Math.floor(Math.random() * agents.length)]!;
      if (victim.role !== st.to) {
        victim.status = 'stuck';
        victim.line = victim.role === 'risk_sentinel' ? '账户快照 47 秒没更新' : '上游接口超时,重试中';
      }
    }
    // 空闲太久的人偶尔自己找活
    for (const a of agents) {
      if (a.status === 'stuck' && Math.random() < 0.35) {
        a.status = 'working';
        a.line = '恢复了,接着干';
      }
    }
    // 收件箱:偶尔清空 / 再来一条,用来验证「0 时隐藏」
    if (Math.random() < 0.12) {
      // 收件箱偶尔变化;待批订单被批完后过一会儿会再来一单(用来验证「0 时隐藏」和信箱灯)
      if (inboxItems.length > 1 && inboxItems.some((x) => x.kind === 'handoff')) inboxItems.splice(inboxItems.findIndex((x) => x.kind === 'handoff'), 1);
      else if (!inboxItems.some((x) => x.kind === 'approval')) inboxItems.push({ id: `i${seq}`, kind: 'approval', title: 'BTC 空单 · 等你批', detail: 'THREAD 提议 0.01 BTC @ 84,120,止损 85,300', at: Date.now() });
    }
  }

  function tickMoney() {
    const d = (Math.random() - 0.48) * 18;
    equity += d;
    pnl += d;
  }

  /** 某个角色今天发生一次进化事件(提炼 / 验证 / 采纳) */
  function tickEvolution() {
    const cands: Role[] = ['reviewer', 'strategy_lab', 'thread_manager', 'radar', 'risk_sentinel', 'portfolio_manager', 'executor', 'gate_captain', 'asp_agent'];
    const role = cands[Math.floor(Math.random() * (Math.random() < 0.6 ? 3 : cands.length))]!;
    const row = evolution.find((r) => r.role === role)!;
    const today = row.days[row.days.length - 1]!;
    const kinds: EvoKind[] = role === 'reviewer' ? ['distill', 'distill', 'verify'] : role === 'strategy_lab' ? ['adopt', 'verify'] : ['distill', 'verify', 'adopt'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)]!;
    const txts = EVO_EVENT_TEXT[kind];
    today.events = (today.events ?? 0) + 1;
    today.last_event = { kind, text: txts[Math.floor(Math.random() * txts.length)]! };
    if (today.events >= 2) today.status = 'good';
    today.score = Math.min(99, (today.score ?? 55) + 6);
    today.headline = `今天 ${today.events} 次进化:${today.last_event.text}`;
    act(role, 'evo', `${ROLES[role].callsign} ${kind === 'distill' ? '提炼了' : kind === 'verify' ? '验证了' : '采纳了'} 1 条教训:${today.last_event.text}`);
  }

  function dispatch(role: Role, task: TaskDef) {
    const a = agent(role);
    a.task = { id: `${task.id}-${Date.now()}`, label: task.label };
    a.status = 'working';
    a.line = task.label;
    act('user', 'task_start', `你派给 ${ROLES[role].callsign}:${task.label}`);
    emit(snapshot());
    window.setTimeout(() => {
      a.task = null;
      a.line = task.result;
      a.today = `${TODAY[role]} 刚刚还帮你${task.label}:${task.result}。`;
      act(role, 'task_done', `${ROLES[role].callsign} 干完了「${task.label}」:${task.result}`);
      emit(snapshot());
    }, 4200 + Math.random() * 2600);
  }
  function approve(id: string, ok: boolean) {
    const i = inboxItems.findIndex((x) => x.id === id);
    const it = i >= 0 ? inboxItems.splice(i, 1)[0]! : null;
    act('user', 'approval', `你${ok ? '批准' : '拒绝'}了「${it?.title ?? '待批订单'}」${ok ? ' → 交给 EXEC' : ''}`);
    if (ok) dispatch('executor', { id: 'exec_approved', label: `执行 ${it?.title.split(' ')[0] ?? ''} 订单`, result: '已成交,止损止盈已挂', real: 'POST /api/approvals/:id' });
    else emit(snapshot());
  }
  function runStrategy(symbol: string, mode: 'paper' | 'live') {
    act('user', 'strategy_run', `你让 EXEC 运行「${strategy.name}」· ${symbol} · ${mode}`);
    dispatch('executor', { id: 'strategy_run', label: `运行 ${strategy.name} · ${symbol}`, result: `${mode} 运行已启动,首单等信号`, real: 'POST /api/strategy-runs' });
  }
  function emergency() {
    for (const a of agents) { a.status = a.role === 'risk_sentinel' ? 'working' : 'waiting'; a.line = a.role === 'risk_sentinel' ? '紧急停止生效:撤掉所有挂单' : '紧急停止中,原地待命'; a.task = null; }
    market.risk_level = 'high';
    act('user', 'system', '你按下了紧急停止:停新开仓、撤挂单,只保留保护腿');
    emit(snapshot());
  }
  function tickMarket() {
    const storm = Number(market.btc_vol_1h) < 2;
    market.btc_vol_1h = storm ? (2.6 + Math.random() * 1.4).toFixed(1) : (0.5 + Math.random() * 0.9).toFixed(1);
    market.risk_level = storm ? (Math.random() < 0.5 ? 'high' : 'mid') : Math.random() < 0.5 ? 'low' : 'mid';
  }

  function tickMeeting() {
    const m = MEETINGS[meetIdx % MEETINGS.length]!;
    meetIdx += 1;
    seq += 1;
    meetings.push({ id: `mt${seq}`, roles: m.roles, topic: m.topic, at: Date.now() });
  }

  function evoDetail(role: Role, date: string): EvoDayDetail | null {
    const row = evolution.find((r) => r.role === role);
    const d = row?.days.find((x) => x.date === date);
    if (!d) return null;
    const n = seeded(role.length * 11 + Number(date.slice(-2)));
    if (d.status === 'none') return { role, date, metrics: [{ label: '判断', value: '0' }, { label: '命中', value: '—' }, { label: '进化事件', value: '0' }], records: [] };
    return {
      role,
      date,
      metrics: [
        { label: '当天判断', value: String(8 + Math.floor(n * 30)) },
        { label: '命中率', value: `${Math.round((d.score ?? 50) * 0.9)}%` },
        { label: '进化事件', value: String(d.events ?? 0) },
      ],
      records: [
        { title: d.last_event ? `${d.last_event.kind === 'distill' ? '提炼' : d.last_event.kind === 'verify' ? '验证' : '采纳'}:${d.last_event.text}` : d.headline ?? '当天记录', detail: `${date} · 来源 AUDIT 复盘 #${100 + Math.floor(n * 800)}` },
        { title: d.status === 'bad' ? 'SOL 空单方向判断错误,止损 -0.6%' : 'ETH 回踩做多,盈利 +0.8%', detail: '判断记录 → 已归因到入场时机' },
      ],
    };
  }

  return {
    snapshot,
    evoDetail,
    dispatch,
    approve,
    runStrategy,
    emergency,
    note(text: string) { act('user', 'system', text); emit(snapshot()); },
    start(onChange) {
      emit = onChange;
      const timers: number[] = [];
      let alive = true;
      const loop = () => {
        if (!alive) return;
        tickHandoff();
        onChange(snapshot());
        timers.push(window.setTimeout(loop, 3800 + Math.random() * 2600));
      };
      timers.push(window.setTimeout(loop, 1800));
      timers.push(window.setInterval(() => { tickMoney(); onChange(snapshot()); }, 2500));
      const meet = () => {
        if (!alive) return;
        tickMeeting();
        onChange(snapshot());
        timers.push(window.setTimeout(meet, 38_000 + Math.random() * 14_000));
      };
      timers.push(window.setTimeout(meet, 11_000));
      const evo = () => {
        if (!alive) return;
        tickEvolution();
        onChange(snapshot());
        timers.push(window.setTimeout(evo, 40_000 + Math.random() * 20_000));
      };
      timers.push(window.setTimeout(evo, 12_000));
      timers.push(window.setInterval(() => { tickMarket(); onChange(snapshot()); }, 32_000));
      return () => {
        alive = false;
        timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      };
    },
  };
}
