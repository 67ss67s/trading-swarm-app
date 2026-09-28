/** 实盘 Jev 判断账本 + /api/judge/live 路由 + judge.live SSE(docs/design/jev-live-2026-09-25.md)。 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { AtomicCallBudget } from '../../../../src/demo/research/judge/store.js';
import { JudgeLiveLedger, judgeLiveSummary, linkOutcome, utcDay, type JudgeLiveRecord } from '../../../../src/demo/judge-live.js';
import { judgeLiveRoutes } from '../../../../src/demo/routes-judge-live.js';
import { extraRouteModules, type RouteContext, type RouteHandler } from '../../../../src/demo/http-extra.js';
import type { StrategyThread } from '../../../../src/demo/types.js';

const H = 3_600_000, NOW = Date.UTC(2026, 8, 25, 12), RUN = 'run_abc123';
const dbs: { close(): void }[] = [];
afterEach(() => { while (dbs.length) dbs.pop()!.close(); vi.restoreAllMocks(); });

function rec(over: Partial<JudgeLiveRecord> = {}): Omit<JudgeLiveRecord, 'created_at'> & { created_at: number } {
  return { id: `jl_${Math.random().toString(36).slice(2)}`, decision_id: 'jd_x', run_id: RUN, strategy_id: 'rs_1', strategy_name: '测试策略', symbol: 'BTCUSDT', timeframe: '1h', as_of: NOW - H, mode: 'shadow', status: 'ok', action: 'follow',
    candidate: { candidate_id: 'c1', direction: 'long', entry: '100', stop: '98', target: '104', reward_risk: 2 },
    questions: [{ key: 'take', type: 'noul', instructions: '合理吗', labels: ['yes', 'no'] }], answers: [{ question_key: 'take', probabilities: { yes: 0.7, no: 0.3 } }], predicates: [],
    state: { candidate: { direction: 'long' }, features: { trend: 'up' }, micro: { requested: true, book: false, liquidations: false, used: false, note: 'no_recording' } },
    reason_codes: [], cost_usd: '0.00003', latency_ms: 800, error: null, model: 'typesafe/jev-1.13-20260917', created_at: NOW - 1000, ...over };
}
const thread = (over: Partial<StrategyThread>): StrategyThread => ({ id: 't1', symbol: 'BTCUSDT', side: 'long', status: 'closed', created_at: NOW - H + 6000, opened_at: NOW - H + 7000, ...over }) as StrategyThread;

function setup() {
  const state = openStateDb(':memory:'); dbs.push(state);
  const ledger = new JudgeLiveLedger(state.db, () => NOW);
  const threads: StrategyThread[] = [];
  const runner = { judgeLedger: ledger, deps: { threads: (id: string) => threads.filter(() => id === RUN), realizedR: (t: StrategyThread) => (t.id === 't1' ? 1.5 : -1) } };
  const rt = Object.assign(new EventEmitter(), { strategyRuns: () => runner });
  const routes: { method: string; path: string; fn: RouteHandler }[] = [], json = vi.fn(), fail = vi.fn();
  judgeLiveRoutes({ rt, store: { marketDb: state.db }, route: (method: string, path: string, fn: RouteHandler) => routes.push({ method, path, fn }), guarded: (fn: RouteHandler) => fn, json, fail } as unknown as RouteContext);
  const call = async (path: string, query = '') => { await routes.find(r => r.path === path)!.fn({} as never, {} as never, new URL(`http://localhost${path}${query}`), {}); };
  return { state, ledger, threads, rt, routes, json, fail, call };
}

describe('JudgeLiveLedger', () => {
  it('按 id 幂等、行不可改、按运行过滤', () => {
    const f = setup();
    const a = rec({ id: 'jl_a' });
    expect(f.ledger.record(a)).toMatchObject({ id: 'jl_a' });
    expect(f.ledger.record(a)).toBeNull();
    f.ledger.record(rec({ id: 'jl_b', run_id: 'run_other' }));
    expect(f.ledger.list().map(r => r.id).sort()).toEqual(['jl_a', 'jl_b']);
    expect(f.ledger.list({ run_id: RUN }).map(r => r.id)).toEqual(['jl_a']);
    expect(f.ledger.list()[1]).toEqual(expect.objectContaining({ candidate: a.candidate, answers: a.answers, state: a.state, cost_usd: '0.00003' }));
    expect(() => f.state.db.prepare("UPDATE judge_live_decisions SET action='skip' WHERE id='jl_a'").run()).toThrow('judge_live_decision_immutable');
  });
  it('线程关联:同币同方向、候选有效期内建的第一条;关联不上 = null', () => {
    const r = rec();
    expect(linkOutcome(r, [thread({})], () => 2)).toEqual({ thread_id: 't1', status: 'closed', opened: true, closed: true, realized_r: 2 });
    expect(linkOutcome(r, [thread({ side: 'short' })])).toBeNull();
    expect(linkOutcome(r, [thread({ created_at: NOW + 5 * H })])).toBeNull();
    expect(linkOutcome(r, [thread({ status: 'in_position' })], () => 9)).toMatchObject({ closed: false, realized_r: null });
  });
});

describe('/api/judge/live', () => {
  it('返回最近判断(带结果对照)与今日汇总', async () => {
    const f = setup();
    f.ledger.record(rec({ id: 'jl_follow' }));
    f.ledger.record(rec({ id: 'jl_skip', symbol: 'ETHUSDT', action: 'skip', created_at: NOW - 500 }));
    f.ledger.record(rec({ id: 'jl_gate', mode: 'gate', action: 'skip', symbol: 'SOLUSDT', created_at: NOW - 400 }));
    f.ledger.record(rec({ id: 'jl_skipped', status: 'skipped', action: null, reason_codes: ['decision_model_unbound'], cost_usd: '0', created_at: NOW - 300 }));
    f.ledger.record(rec({ id: 'jl_old', created_at: NOW - 2 * 86_400_000 }));
    f.threads.push(thread({}), thread({ id: 't2', symbol: 'ETHUSDT' }));
    const day = utcDay(NOW), b = AtomicCallBudget.create(f.state.db, `live:shadow:${RUN}:${day}`, 200, '0.03');
    b.reserve('0.00015'); f.state.db.prepare('UPDATE research_call_budgets SET spent_usd=?,reserved_usd=? WHERE id=?').run('0.00004', '0', b.id);
    AtomicCallBudget.create(f.state.db, `live:shadow:${RUN}:${day - 86_400_000}`, 200, '0.03').reserve('0.00015');
    AtomicCallBudget.create(f.state.db, `matrix:whatever:${day}`, 5, '1').reserve('0.5');
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await f.call('/api/judge/live', '?limit=10');
    const body = f.json.mock.calls[0]![2] as { items: (JudgeLiveRecord & { outcome: unknown })[]; summary: ReturnType<typeof judgeLiveSummary> };
    expect(f.json.mock.calls[0]![1]).toBe(200);
    expect(body.items.map(i => i.id)).toEqual(['jl_skipped', 'jl_gate', 'jl_skip', 'jl_follow', 'jl_old']);
    expect(body.items.find(i => i.id === 'jl_follow')!.outcome).toMatchObject({ thread_id: 't1', realized_r: 1.5 });
    expect(body.items.find(i => i.id === 'jl_gate')!.outcome).toBeNull();
    expect(body.summary.today).toMatchObject({ judged: 4, calls: 1, cost_usd: '0.00004', reserved_usd: '0', follow: 1, skip: 2, errors: 0, skipped: 1, shadow: 3, gate: 1, skip_reasons: { decision_model_unbound: 1 } });
    expect(body.summary.today.follow_ratio).toBeCloseTo(1 / 3);
    expect(body.summary.budgets).toEqual([{ run_id: RUN, max_calls: 200, calls: 1, max_usd: '0.03', spent_usd: '0.00004', reserved_usd: '0' }]);
    // 影子 follow 行(jl_follow + jl_old,都关联到 t1 = +1.5R);影子 skip 行 jl_skip 关联 t2 = -1R
    expect(body.summary.comparison.follow).toMatchObject({ judged: 2, traded: 2, closed: 2, wins: 2, realized_r_sum: 3, avg_r: 1.5 });
    expect(body.summary.comparison.skip).toMatchObject({ judged: 1, traded: 1, closed: 1, wins: 0, avg_r: -1 });
    await f.call('/api/judge/live', `?run_id=${RUN}&limit=2`);
    expect((f.json.mock.calls[1]![2] as { items: unknown[] }).items).toHaveLength(2);
    await f.call('/api/judge/live/summary');
    expect(f.json.mock.calls[2]![2]).toMatchObject({ today: { judged: 4 } });
  });
  it('参数校验:limit / run_id 不合法 → 400', async () => {
    const f = setup();
    await f.call('/api/judge/live', '?limit=abc'); await f.call('/api/judge/live', '?run_id=../etc'); await f.call('/api/judge/live/summary', '?run_id=RUN_X');
    expect(f.fail).toHaveBeenCalledTimes(3); expect(f.fail.mock.calls.every(c => c[1] === 400)).toBe(true); expect(f.json).not.toHaveBeenCalled();
  });
  it('SSE:新判断推 judge.live 帧,断开后解除订阅', async () => {
    const f = setup();
    const req = new EventEmitter(), res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), write: vi.fn() });
    await f.routes.find(r => r.path === '/api/judge/live/stream')!.fn(req as never, res as never, new URL('http://localhost/api/judge/live/stream'), {});
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'text/event-stream' }));
    f.rt.emit('judge.live', { id: 'jl_new', mode: 'shadow' });
    expect(res.write).toHaveBeenCalledWith(`event: judge.live\ndata: ${JSON.stringify({ id: 'jl_new', mode: 'shadow' })}\n\n`);
    expect(f.rt.listenerCount('judge.live')).toBe(1);
    req.emit('close');
    expect(f.rt.listenerCount('judge.live')).toBe(0);
  });
  it('在 http-extra 注册', () => { expect(extraRouteModules).toContain(judgeLiveRoutes); });
});
