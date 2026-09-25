/**
 * 楼层 v4:真实数据 → 引擎快照(components/floor-v4/snapshot.ts)与派活表(tasks.ts)的关键分支。
 */
import { describe, expect, it } from 'vitest';
import type { ActivityItem, BotHandoff, BotsResponse, DemoIntent, HistoryResponse, Kline, Overview, PortfolioSnapshotResponse } from '../src/api/types';
import type { EvoDailyResponse } from '../src/api/evolution';
import type { ResearchStrategy } from '@trading-swarm/contracts';
import { btcVol1h, buildDeco, buildEvoRows, buildFloorModel, deriveMeetings, evoRoleOf, pickStrategy, pnlToday, presenceToStatus, riskToWeather, toSnapshotA } from '../src/components/floor-v4/snapshot';
import { coinTask, normSym, parseCommand, realTasks, type TaskContext } from '../src/components/floor-v4/tasks';

const NOW = Date.UTC(2026, 8, 25, 6, 0, 0);
const DAY0 = Date.UTC(2026, 8, 25);

function bot(role: string, state: string | null, action: string | null = null) {
  return {
    role, name: role, kind: 'x', description: '', model_pin: null, capabilities: [], memory_scope: '', approval_boundary: '', enabled: true, note: null, sort_order: 1, created_at: 0, updated_at: 0,
    ...(state ? { presence: { state, action, since: null, next_at: null } } : {}),
  };
}
function handoff(id: string, from: string, to: string, at: number, status = 'pending', kind = 'result'): BotHandoff {
  return { handoff_id: id, run_id: null, from_role: from, to_role: to, kind, subject: { type: 'screen', id: 's1' }, summary: `summary ${id}`, evidence_refs: [], artifact_refs: [], requested_output_schema: null, priority: 1, deadline_at: null, idempotency_key: id, status, created_at: at, acked_at: null, payload: null } as unknown as BotHandoff;
}
function act(id: string, kind: string, at: number, extra: Partial<ActivityItem> = {}): ActivityItem {
  return { id, at, kind, level: 'info', symbol: 'BTCUSDT', thread_id: null, episode_id: null, title: `title ${id}`, detail: null, data: {}, ...extra } as ActivityItem;
}
function intent(id: string, status: string, at = NOW - 60_000, principal: 'agent' | 'user' = 'agent'): DemoIntent {
  return { id, episode_id: 'e', thread_id: null, principal, at, kind: 'open', symbol: 'SOLUSDT', direction: 'long', quantity: '2', entry: 'market', limit_price: null, stop_price: '100', take_profit_price: null, sizing: { note: '' }, status, client_order_id: null, backend: 'okx', receipts: [], error: null } as unknown as DemoIntent;
}
function strategy(id: string, status: string, updated_at: number): ResearchStrategy {
  return { id, name: `S-${id}`, description: '', status, symbol: 'BTCUSDT', timeframe: '1h', watchlist: false, alerts: false, current_version: 2, created_at: 0, updated_at, origin: { session_id: null, inquiry_id: null, source: 'manual' }, summary: null, lab_strategy_id: null, published_listing_id: null } as ResearchStrategy;
}
const overview = (extra: Record<string, unknown> = {}) =>
  ({
    loop: { halted: false, paused: false, backend: 'okx' },
    account: { backend: 'okx', equity: '1100.00', available: '0', unrealized_pnl: '3.5', positions: [{ symbol: 'BTCUSDT', side: 'long', qty: '0.01', entry_price: '84000', mark_price: '84100', unrealized_pnl: '1.25', leverage: 1 }], open_orders: [], as_of: NOW },
    workflow: { watchlist: ['BTCUSDT', 'ETHUSDT'], daily_loss_stop_pct: '3' },
    markets: { BTCUSDT: { last: '84100.5' }, ETHUSDT: { last: '2683.1' } },
    market_state: { candidates: [{ symbol: 'SOLUSDT' }, { symbol: 'BTCUSDT' }], risk_events: [] },
    threads: [{ symbol: 'ETHUSDT', status: 'in_position' }],
    queue: { pending: 2, running: null },
    usage_today: { judgments: 10, cap: 100 },
    ...extra,
  }) as unknown as Overview;

describe('presenceToStatus', () => {
  it('maps gateway presence states to engine statuses', () => {
    expect(presenceToStatus('thinking')).toBe('working');
    expect(presenceToStatus('working')).toBe('working');
    expect(presenceToStatus('waiting')).toBe('waiting');
    expect(presenceToStatus('blocked')).toBe('stuck');
    expect(presenceToStatus('off')).toBe('idle');
    expect(presenceToStatus(undefined)).toBe('idle');
  });
});

describe('pnlToday', () => {
  it('uses the last equity point before UTC midnight as the base', () => {
    const history = { equity: [{ at: DAY0 - 3600_000, equity: 1000, unrealized: 0 }, { at: DAY0 + 60_000, equity: 1050, unrealized: 0 }] } as HistoryResponse;
    expect(pnlToday({ now: NOW, overview: overview(), history })).toBe('100.00');
  });
  it('falls back to the first point of today when there is nothing before midnight', () => {
    const history = { equity: [{ at: DAY0 + 60_000, equity: 1200, unrealized: 0 }] } as HistoryResponse;
    expect(pnlToday({ now: NOW, overview: overview(), history })).toBe('-100.00');
  });
  it('ignores equity points from another backend', () => {
    const history = { equity: [{ at: DAY0 - 1, equity: 500, unrealized: 0, backend: 'paper' }, { at: DAY0 - 2, equity: 1000, unrealized: 0, backend: 'okx' }] } as HistoryResponse;
    expect(pnlToday({ now: NOW, overview: overview(), history })).toBe('100.00');
  });
  it('falls back to daily_loss_pct (positive = loss) without a curve', () => {
    expect(pnlToday({ now: NOW, overview: overview({ daily_loss_pct: '1.00' }), history: null })).toBe('-11.00');
    expect(pnlToday({ now: NOW, overview: null, history: null })).toBe('0');
  });
});

describe('btcVol1h / riskToWeather', () => {
  it('computes (high - low) / first open over the window', () => {
    const k = (o: string, h: string, l: string) => ({ open_time: 0, open: o, high: h, low: l, close: o, volume: '1', close_time: 0 }) as Kline;
    expect(btcVol1h([k('100', '101', '99'), k('100', '103', '100')])).toBe('4.00');
    expect(btcVol1h([])).toBe('0');
    expect(btcVol1h(null)).toBe('0');
  });
  it('maps risk levels to weather', () => {
    expect(riskToWeather('critical')).toBe('high');
    expect(riskToWeather('high')).toBe('high');
    expect(riskToWeather('warn')).toBe('mid');
    expect(riskToWeather('none')).toBe('low');
    expect(riskToWeather(undefined)).toBe('low');
  });
});

describe('pickStrategy', () => {
  it('prefers a running strategy, then live > paper > recent; never archived', () => {
    const list = [strategy('a', 'draft', 30), strategy('b', 'paper', 10), strategy('c', 'archived', 99), strategy('d', 'live', 5)];
    expect(pickStrategy(list)?.id).toBe('d');
    expect(pickStrategy(list, new Set(['a']))?.id).toBe('a');
    expect(pickStrategy([strategy('x', 'archived', 1)])).toBeNull();
    expect(pickStrategy([strategy('p', 'draft', 1), strategy('q', 'draft', 2)])?.id).toBe('q');
  });
});

describe('buildFloorModel', () => {
  const bots = {
    bots: [bot('gate_captain', 'waiting', '2 条交接待阅'), bot('radar', 'thinking', '扫描 SOL'), bot('executor', 'blocked', '没登录'), bot('strategy_lab', null), bot('future_role', 'working')],
    runs: [],
    handoffs: [handoff('h1', 'radar', 'gate_captain', NOW - 60_000), handoff('h2', 'radar', 'future_role', NOW - 30_000), handoff('h3', 'reviewer', 'strategy_lab', NOW - 48 * 3600_000, 'acked')],
  } as unknown as BotsResponse;
  const activity = [act('a1', 'trigger', NOW - 10_000), act('a2', 'approved', NOW - 5_000), act('a3', 'unknown_kind', NOW - 1_000)];
  const m = buildFloorModel({
    now: NOW,
    bots,
    activity,
    overview: overview(),
    intents: [intent('i1', 'pending_approval'), intent('i2', 'filled'), intent('i3', 'pending_approval', NOW - 1_000, 'agent')],
    strategies: [strategy('s1', 'paper', 1)],
    tasks: { strategy_lab: { id: 'backtest:', label: '回测' } },
  });

  it('keeps only known roles, in engine order, with presence mapped', () => {
    expect(m.agents.map((a) => a.role)).toEqual(['gate_captain', 'radar', 'strategy_lab', 'executor']);
    expect(m.agents.find((a) => a.role === 'radar')).toMatchObject({ status: 'working', line: '扫描 SOL', callsign: 'RADAR' });
    expect(m.agents.find((a) => a.role === 'executor')?.status).toBe('stuck');
  });
  it('a dispatched task makes an idle agent look busy and is passed through', () => {
    const lab = m.agents.find((a) => a.role === 'strategy_lab')!;
    expect(lab.status).toBe('working');
    expect(lab.task).toEqual({ id: 'backtest:', label: '回测' });
  });
  it('every agent gets three real key numbers', () => {
    for (const a of m.agents) expect(a.stats).toHaveLength(3);
    expect(m.agents[0]!.stats![0]).toEqual({ label: '待批订单', value: '1' });
    expect(m.agents.find((a) => a.role === 'radar')!.stats![0]).toEqual({ label: '观察币', value: '2' });
  });
  it('envelopes = real handoffs + role→role activity within 24h; unknown roles / users / old rows dropped', () => {
    const ids = m.handoffs.map((h) => h.id);
    expect(ids).toContain('hof:h1');
    expect(ids).toContain('act:a1'); // trigger: radar → thread_manager
    expect(ids).not.toContain('hof:h2'); // future_role
    expect(ids).not.toContain('hof:h3'); // 48h old
    expect(ids).not.toContain('act:a2'); // approved: user → executor
    expect(m.handoffs.at(-1)?.id).toBe('act:a1'); // oldest first, newest last
  });
  it('feed keeps user rows and tags sources, newest first', () => {
    expect(m.feed[0]).toMatchObject({ key: 'act:a2', from: 'user', to: 'executor', source: 'activity', tone: 'ok' });
    expect(m.feed.find((r) => r.key === 'hof:h1')).toMatchObject({ source: 'handoff', status: 'pending' });
    expect(m.feed.some((r) => r.key === 'act:a3')).toBe(false);
  });
  it('inbox = pending_approval intents (agent self-approval blips ignored) + pending handoffs', () => {
    expect(m.pendingIntents.map((i) => i.id)).toEqual(['i1']);
    expect(m.inbox.items.filter((i) => i.kind === 'approval').map((i) => i.id)).toEqual(['i1']);
    expect(m.inbox.items.filter((i) => i.kind === 'handoff').map((i) => i.id)).toEqual(['h2', 'h1']);
    expect(m.inbox.count).toBe(3);
  });
  it('money from the execution account', () => {
    expect(m.money).toEqual({ equity: '1100.00', pnl_today: '0', positions: 1 });
  });
  it('current strategy card maps research status to engine stage', () => {
    expect(m.strategy).toEqual({ id: 's1', name: 'S-s1', symbol: 'BTCUSDT', stage: 'paper' });
    expect(m.strategyObj?.id).toBe('s1');
  });
  it('falls back to the local roster when /api/bots is missing', () => {
    const local = buildFloorModel({ now: NOW, bots: null });
    expect(local.agents.length).toBe(9);
    expect(local.handoffs).toEqual([]);
    expect(local.inbox.count).toBe(0);
    expect(local.halted).toBe(false);
  });
  it('evolution rows: all 9 roles × 30 UTC days ending today, real days aligned by date, unknown roles dropped', () => {
    const d = (off: number) => new Date(DAY0 - off * 86_400_000).toISOString().slice(0, 10);
    const summary = { good: 0, ok: 0, bad: 0, none: 0, baseline_days: 0 };
    const evo = {
      version: '1', from: '', to: '', today: null,
      roles: [
        // 90 天里只有最近几天有状态(现网就是这样)
        { role: 'radar', label: '', metric_label: '', summary, days: Array.from({ length: 90 }, (_, i) => ({ date: d(89 - i), status: (i >= 85 ? 'ok' : 'none') as 'ok' | 'none', score: null, headline: null })) },
        { role: 'executor', label: '', metric_label: '', summary, days: [{ date: d(0), status: 'bad' as const, score: null, headline: 'x', events: 2 }, { date: d(3), status: 'good' as const, score: 1, headline: null }] },
        { role: 'mystery', label: '', metric_label: '', summary, days: [{ date: d(0), status: 'good' as const, score: 1, headline: null }] },
      ],
    } as EvoDailyResponse;
    const x = buildFloorModel({ now: NOW, bots, evolution: evo });
    expect(x.evolution).toHaveLength(9);
    for (const r of x.evolution ?? []) {
      expect(r.days).toHaveLength(30);
      expect(r.days.at(-1)?.date).toBe(d(0));
      expect(r.days[0]?.date).toBe(d(29));
    }
    const radar = x.evolution!.find((r) => r.role === 'radar')!;
    expect(radar.days.slice(-6).map((z) => z.status)).toEqual(['none', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const exec = x.evolution!.find((r) => r.role === 'executor')!;
    expect(exec.days.at(-1)).toMatchObject({ status: 'bad', events: 2 });
    expect(exec.days.at(-4)?.status).toBe('good');
    expect(exec.days.at(-2)?.status).toBe('none'); // 接口缺的日子补灰格
    expect(x.evolution!.find((r) => r.role === 'reviewer')!.days.every((z) => z.status === 'none')).toBe(true);
  });
  it('evolution rows: no data at all still gives 9 grey rows; role aliases map to floor roles', () => {
    expect(buildEvoRows(null, NOW).map((r) => r.days.length)).toEqual(Array(9).fill(30));
    expect(evoRoleOf('judge')).toBe('thread_manager');
    expect(evoRoleOf('RADAR')).toBe('radar');
    expect(evoRoleOf('nope')).toBeNull();
  });
});

describe('deriveMeetings', () => {
  it('3+ roles on the same thread within 3 minutes = a meeting led by HELM', () => {
    const acts = [act('p', 'proposal', NOW - 60_000, { thread_id: 't1', symbol: 'SOLUSDT' }), act('b', 'proposal_blocked', NOW - 30_000, { thread_id: 't1' }), act('x', 'trigger', NOW - 20_000, { thread_id: 't2' })];
    const ms = deriveMeetings(acts, NOW);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.id).toBe('mt:t1');
    expect(ms[0]!.roles[0]).toBe('gate_captain');
    expect(new Set(ms[0]!.roles)).toEqual(new Set(['gate_captain', 'thread_manager', 'risk_sentinel']));
    expect(ms[0]!.topic).toContain('SOLUSDT');
  });
  it('ignores old or two-role chains', () => {
    expect(deriveMeetings([act('p', 'proposal', NOW - 7 * 3600_000, { thread_id: 't1' }), act('b', 'proposal_blocked', NOW - 7 * 3600_000, { thread_id: 't1' })], NOW)).toEqual([]);
    expect(deriveMeetings([act('p', 'trigger', NOW - 1000, { thread_id: 't1' })], NOW)).toEqual([]);
  });
});

describe('buildDeco', () => {
  it('real positions, last fill and watchlist prices; exposure from the portfolio snapshot', () => {
    const portfolio = { snapshot: { equity: 1000, positions: { gross: 1020, long: 1020, short: 0, net: 1020, gross_ratio: 1.02 }, by_symbol: { BTCUSDT: { gross: 800, long: 800, short: 0, net: 800, gross_ratio: 0.8 }, ETHUSDT: { gross: 220, long: 220, short: 0, net: 220, gross_ratio: 0.22 } }, by_cluster: {} } } as unknown as PortfolioSnapshotResponse;
    const d = buildDeco({ overview: overview(), portfolio, activity: [act('f', 'entry_filled', NOW, { symbol: 'XRPUSDT' })] });
    expect(d.tape[0]).toEqual({ text: 'POS BTC LONG +1.3', tone: 'up' });
    expect(d.tape).toContainEqual({ text: 'FILL XRP', tone: 'hi' });
    expect(d.tape).toContainEqual({ text: 'BTC 84101', tone: 'hi' });
    expect(d.exposurePct).toBe('102%');
    expect(d.byCoin).toEqual([['BTC', 0.8], ['ETH', 0.22]]);
    expect(d.ledger[0]).toEqual(['BTC', 'LONG', '0.0100', '84000', '84100', '+1.25']);
  });
  it('no data → nothing invented', () => {
    expect(buildDeco({ overview: null, portfolio: null, activity: [] })).toEqual({ tape: [], exposurePct: null, byCoin: [], ledger: [] });
  });
});

describe('toSnapshotA', () => {
  it('renames fields for layout A and adds meeting.until / market / strategy version', () => {
    const m = buildFloorModel({ now: NOW, bots: { bots: [bot('radar', 'working', 'x')], runs: [], handoffs: [] } as unknown as BotsResponse, overview: overview(), strategies: [strategy('s1', 'live', 1)], tasks: { radar: { id: 't', label: 'L' } } });
    const a = toSnapshotA(m, NOW);
    expect(a.now).toBe(NOW);
    expect(a.agents[0]).toMatchObject({ role: 'radar', task: { id: 't', label: 'L', icon: 'eye' } });
    expect(a.agents[0]!.metrics).toHaveLength(3);
    expect(a.market).toMatchObject({ risk_level: 'low', utc_hour: 6 });
    expect(a.strategy).toEqual({ id: 's1', name: 'S-s1', version: 'v2' });
    expect(a.halted).toBe(false);
  });
});

describe('tasks', () => {
  const m = buildFloorModel({ now: NOW, overview: overview(), strategies: [strategy('s1', 'paper', 1)] });
  const ctx: TaskContext = { model: m, watchlist: ['BTCUSDT'], candidates: ['BTCUSDT', 'SOLUSDT'], threadSymbols: ['ETHUSDT'] };
  it('radar offers the first candidate not yet watched', () => {
    expect(realTasks('radar', ctx)[0]).toMatchObject({ kind: 'watch', symbol: 'SOLUSDT' });
  });
  it('thread judges the open-thread symbol first, then the whole list', () => {
    expect(realTasks('thread_manager', ctx).map((t) => t.id)).toEqual(['judge:ETHUSDT', 'judge:all']);
  });
  it('lab backtests the current strategy, or points to My strategies when there is none', () => {
    expect(realTasks('strategy_lab', ctx)[0]?.kind).toBe('backtest');
    expect(realTasks('strategy_lab', { ...ctx, model: buildFloorModel({ now: NOW }) })[0]).toMatchObject({ kind: 'goto', hash: 'my-strategies' });
    expect(realTasks('executor', ctx)[0]).toMatchObject({ kind: 'goto', hash: 'trade' });
  });
  it('coin drops: RADAR watch / THREAD judge / LAB backtest / others refuse', () => {
    expect(coinTask('radar', 'SOLUSDT', ctx)?.kind).toBe('watch');
    expect(coinTask('thread_manager', 'SOLUSDT', ctx)).toMatchObject({ kind: 'judge', symbol: 'SOLUSDT' });
    expect(coinTask('strategy_lab', 'SOLUSDT', ctx)).toMatchObject({ kind: 'backtest', symbol: 'SOLUSDT' });
    expect(coinTask('executor', 'SOLUSDT', ctx)).toBeNull();
  });
  it('command line', () => {
    expect(normSym('sol')).toBe('SOLUSDT');
    expect(parseCommand('让 radar 盯 SOL', ctx)).toMatchObject({ role: 'radar', task: { kind: 'watch', symbol: 'SOLUSDT' } });
    expect(parseCommand('判断 btc', ctx)).toMatchObject({ role: 'thread_manager', task: { symbol: 'BTCUSDT' } });
    expect(parseCommand('回测 ETH', ctx)).toMatchObject({ role: 'strategy_lab', task: { kind: 'backtest', symbol: 'ETHUSDT' } });
    expect(parseCommand('查风险', ctx)?.role).toBe('risk_sentinel');
    expect(parseCommand('随便说说', ctx)).toBeNull();
  });
});
