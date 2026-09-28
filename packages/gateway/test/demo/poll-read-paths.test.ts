// 轮询读路径(/api/bots、/api/strategy-runs、/api/activity、/api/episodes)的省 CPU 改动:口径与原实现一致。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { StrategyRunStore, type StrategyRunEvent } from '../../src/demo/strategy-run.js';
import { summarize, type ActivityItem, type Episode } from '../../src/demo/types.js';

let state: StateDb | undefined;
let dir: string | undefined;
afterEach(() => { state?.close(); state = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const act = (id: string, at: number, title = 't'): ActivityItem => ({ id, at, kind: 'execution_changed', level: 'info', symbol: null, thread_id: null, episode_id: null, title, detail: null, data: { big: 'x'.repeat(100) } } as ActivityItem);

function episode(id: string, at: number, thread_id: string | null): Episode {
  return {
    id, at, symbol: 'BTCUSDT', thread_id, status: 'done', origin: 'scan',
    trigger: { kind: 'scheduled', detail: 'd', hits: [{ a: 1 }] },
    judgment: { action: 'NO_TRADE', direction: null, headline: 'h', confidence: 0.4, reasons: ['r1'], thesis: 'long thesis', watch_conditions: ['w'], evidence_refs: ['e1'] },
    strategy_before: { state: 'watching' }, strategy_after: { state: 'watching' },
    intent: null, reducer: { applied: true }, schema_errors: [], error: null, graph: { node: 'scan' },
    strategy_council: { consensus: { reached: true, direction: 'long', agreeing: ['a', 'b'], required: 2, abstaining: [], gate_effective: true, entry_timing: 'confirmed' }, verdicts: [{ v: 1 }], code_consensus: { x: 1 }, text: 'council text' },
    entry_advice: { recommended: 'limit', market_blocked: false, text: 'entry text', reason: 'why' },
    context_text: 'c'.repeat(5000), evidence: [{ id: 'I1', text: 'e'.repeat(2000) }], evidence_plan: { steps: [1, 2, 3] }, decision_record: { allowed: ['NO_TRADE'] }, judgment_raw: '{"raw":true}', memory: [{ id: 'm1' }],
  } as unknown as Episode;
}

describe('轮询读路径', () => {
  it('pendingCount 与 handoffs(limit).length 同口径(含封顶)', () => {
    state = openStateDb(':memory:'); const s = new DemoStore(state);
    const h = (i: number, to: 'gate_captain' | 'radar') => s.bots.handoff({ handoff_id: `h${i}`, run_id: null, from_role: 'radar', to_role: to, kind: 'result', subject: { type: 't', id: String(i) }, summary: 's', evidence_refs: [], artifact_refs: [], requested_output_schema: null, priority: 1, deadline_at: null, idempotency_key: `k${i}`, payload: { big: 'p'.repeat(50) }, created_at: 1000 + i });
    expect(s.bots.pendingCount('gate_captain', 50)).toBe(0);
    for (let i = 0; i < 7; i++) h(i, i % 2 ? 'radar' : 'gate_captain');
    s.bots.ack('h0');
    const same = (cap: number) => expect(s.bots.pendingCount('gate_captain', cap)).toBe(s.bots.handoffs({ status: 'pending', to_role: 'gate_captain', limit: cap }).length);
    same(50); same(2);
    expect(s.bots.pendingCount('gate_captain', 50)).toBe(3);
    const plan = (sql: string) => (state!.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan('SELECT * FROM demo_bot_run ORDER BY started_at DESC LIMIT 20')).toContain('idx_demo_bot_run_started');
    expect(plan('SELECT * FROM demo_bot_handoff ORDER BY created_at DESC LIMIT 20')).toContain('idx_demo_bot_handoff_created');
  });

  it('episodes / episodesForThread:剔大字段后摘要与全量解析逐字段相同;saveEpisode 后立刻可见', () => {
    state = openStateDb(':memory:'); const s = new DemoStore(state);
    const eps = [episode('e1', 1000, 't1'), episode('e2', 2000, null), { ...episode('e3', 3000, 't1'), strategy_council: null, entry_advice: undefined, origin: undefined } as unknown as Episode];
    for (const e of eps) s.saveEpisode(e);
    const expected = [...eps].reverse().map((e) => summarize(JSON.parse(JSON.stringify(e)) as Episode));
    expect(s.episodes(50)).toEqual(expected);
    expect(s.episodes(50, 3000)).toEqual(expected.slice(1));
    expect(s.episodesForThread('t1')).toEqual(expected.filter((e) => e.thread_id === 't1'));
    const first = s.episodes(50); first.pop();
    expect(s.episodes(50)).toHaveLength(3); // 返回浅拷贝,调用方改数组不污染缓存
    s.saveEpisode({ ...eps[0]!, status: 'error', error: 'boom' } as Episode);
    expect(s.episodes(50).find((e) => e.id === 'e1')).toMatchObject({ status: 'error', error: 'boom' });
    s.saveEpisode(episode('e4', 4000, null));
    expect(s.episodes(50)[0]?.id).toBe('e4');
  });

  it('intentsForThread 与 intents(500).filter 同口径(窗口、顺序、market 缺省)', () => {
    state = openStateDb(':memory:'); const s = new DemoStore(state);
    for (let i = 0; i < 12; i++) s.saveIntent({ id: `i${i}`, episode_id: `e${i}`, at: 1000 + (i % 4), status: 'filled', kind: i % 3 ? 'open' : 'close', thread_id: i % 2 ? 't1' : i % 5 ? 't2' : null, ...(i === 4 ? { market: 'spot' } : {}) } as never);
    for (const t of ['t1', 't2', 'none']) expect(s.intentsForThread(t)).toEqual(s.intents(500).filter((x) => x.thread_id === t));
    expect(s.intentsForThread('t1').length).toBeGreaterThan(0);
  });

  it('activityPage 缓存:本连接写入与其它连接写入都立刻失效', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-poll-'));
    const file = path.join(dir, 'state.sqlite');
    state = openStateDb(file); const s = new DemoStore(state);
    for (let i = 0; i < 3; i++) s.saveActivity(act(`a${i}`, 1000 + i));
    const p1 = s.activityPage(50);
    expect(p1.activity.map((a) => a.id)).toEqual(['a2', 'a1', 'a0']);
    p1.activity.length = 0;
    expect(s.activityPage(50).activity).toHaveLength(3);
    s.saveActivity(act('a3', 1003));
    expect(s.activityPage(50).activity[0]?.id).toBe('a3');
    s.saveActivity(act('a3', 1003, 'renamed')); // upsert 改 json
    expect(s.activityPage(50).activity[0]?.title).toBe('renamed');
    expect(s.activity(2).map((a) => a.id)).toEqual(['a3', 'a2']);
    // 别的连接(别的进程)写库:data_version 变化 → 缓存作废
    const other = new DatabaseSync(file);
    other.prepare('INSERT INTO demo_activity(id, at, kind, level, symbol, thread_id, json, market) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('x1', 2000, 'execution_changed', 'info', null, null, JSON.stringify(act('x1', 2000)), null);
    other.close();
    expect(s.activityPage(50).activity[0]?.id).toBe('x1');
  });

  it('eventStats 与逐条读事件数出来的统计一致(含平仓 upsert 行)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE strategy_run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL); CREATE INDEX strategy_run_events_kind ON strategy_run_events(run_id, kind, at);');
    const store = new StrategyRunStore(db);
    const ev = (i: number, run_id: string, kind: StrategyRunEvent['kind'], at: number, data: Record<string, unknown> | null = null): StrategyRunEvent => ({ id: `e${i}`, run_id, at, kind, symbol: 'BTCUSDT', message: 'm', data });
    const kinds: StrategyRunEvent['kind'][] = ['scan', 'candidate', 'order_opened', 'skip', 'agent_skip', 'order_rejected', 'published', 'error', 'order_opened', 'scan'];
    kinds.forEach((k, i) => store.append(ev(i, 'r1', k, 1000 + i, k === 'order_opened' ? (i === 2 ? { thread_id: 'th1' } : null) : null)));
    store.append(ev(99, 'r2', 'scan', 5));
    db.prepare('INSERT INTO strategy_run_events(id,run_id,at,kind,json) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run('closed1', 'r1', 1, 'exit', JSON.stringify(ev(0, 'r1', 'exit', 1)));
    const rows = store.since('r1', 0);
    const st = store.eventStats('r1');
    for (const k of new Set(rows.map((e) => e.kind))) expect(st.kinds.get(k)).toBe(rows.filter((e) => e.kind === k).length);
    expect(st.opened.map((o) => o.at)).toEqual(rows.filter((e) => e.kind === 'order_opened').map((e) => e.at));
    expect(new Set(st.opened.map((o) => o.thread_id))).toEqual(new Set(rows.filter((e) => e.kind === 'order_opened').map((e) => e.data?.['thread_id'])));
    expect(store.eventStats('nope')).toEqual({ kinds: new Map(), opened: [] });
    db.close();
  });
});
